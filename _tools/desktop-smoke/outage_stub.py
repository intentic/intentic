#!/usr/bin/env python3
"""The workspace's address for outage.sh, and the only witness to what the app's window did with it.

WebKitGTK in a release build has no debugger to ask which page a window holds, and the app's frame is titled
"Intentic" whichever page it is (the offline page, the face, the hosted editor or an error page). So the address
itself keeps a log: every request, as one JSON line, tells a LOAD of the workspace (a GET for HTML) apart from a
CHECK of whether it answers (the offline page's fetch, the app's HEAD) and from the page's REPORT of what the app
told it (`window.__INTENTIC_DESKTOP__`).

    outage_stub.py serve --port N --mode-file F --log L    answers as F says ("530", any other status, or "ready")
    outage_stub.py loads L                                 how many loads L holds
    outage_stub.py checks L                                how many checks L holds
    outage_stub.py reports L                               each report's machineFace, one per line
    outage_stub.py tail L                                  the last requests, for a failure to show
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

READY_PAGE = b"""<!doctype html><html><head><title>Intentic outage smoke workspace</title></head><body>ready<script>
(function () {
    var d = window.__INTENTIC_DESKTOP__;
    var q = new URLSearchParams({ desktop: String(!!d), machineFace: String(!!(d && d.machineFace === true)) });
    fetch("/__report?" + q.toString(), { cache: "no-store" }).catch(function () {});
})();
</script></body></html>"""


def error_page(status):
    return (
        "<!doctype html><html><head><title>intentic.dev | %d: Cloudflare Tunnel error</title></head><body>"
        "<h1>Error 1033</h1><p>Cloudflare is currently unable to resolve it.</p>"
        "<p>[outage smoke: a dead platform host behind Cloudflare]</p></body></html>" % status
    ).encode()


def is_load(entry):
    """A top-level load of the workspace: a GET for HTML that is neither the report nor an icon."""
    path = entry.get("path", "")
    return (
        entry.get("method") == "GET"
        and "text/html" in entry.get("accept", "")
        and not path.startswith("/__")
        and path != "/favicon.ico"
    )


def is_report(entry):
    return entry.get("path", "").startswith("/__report")


def read_log(path):
    try:
        with open(path, encoding="utf-8") as log:
            return [json.loads(line) for line in log if line.strip()]
    except FileNotFoundError:
        return []


def serve(port, mode_file, log_path):
    class Handler(BaseHTTPRequestHandler):
        # What a host behind Cloudflare is answered by, in place of the base class's own "BaseHTTP/… Python/…".
        server_version = "cloudflare"
        sys_version = ""

        def _answer(self, with_body):
            entry = {
                "method": self.command,
                "path": self.path,
                "accept": self.headers.get("Accept", ""),
                "userAgent": self.headers.get("User-Agent", ""),
                "at": time.time(),
            }
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(json.dumps(entry) + "\n")
            if is_report(entry):
                self.send_response(204)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            # Read on every request, so outage.sh changes what the address answers without a restart.
            try:
                with open(mode_file, encoding="utf-8") as mode:
                    wanted = mode.read().strip()
            except FileNotFoundError:
                wanted = "ready"
            if wanted == "ready":
                status, body = 200, READY_PAGE
            else:
                status = int(wanted)
                body = error_page(status)
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if with_body:
                self.wfile.write(body)

        def do_GET(self):
            self._answer(True)

        def do_HEAD(self):
            self._answer(False)

        def log_message(self, format, *args):  # noqa: A002 (the base class's own parameter name)
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "serve":
        options = dict(zip(argv[2::2], argv[3::2]))
        serve(int(options["--port"]), options["--mode-file"], options["--log"])
        return 0
    if command in ("loads", "checks", "reports", "tail") and len(argv) == 3:
        entries = read_log(argv[2])
        if command == "loads":
            print(sum(1 for entry in entries if is_load(entry)))
        elif command == "checks":
            print(sum(1 for entry in entries if not is_load(entry) and not is_report(entry)))
        elif command == "reports":
            for entry in entries:
                if is_report(entry):
                    query = parse_qs(urlsplit(entry["path"]).query)
                    print(query.get("machineFace", ["false"])[0])
        else:
            for entry in entries[-12:]:
                kind = "load" if is_load(entry) else ("report" if is_report(entry) else "check")
                print("%s %s accept=%s [%s]" % (entry["method"], entry["path"], entry.get("accept") or "-", kind))
        return 0
    sys.stderr.write(__doc__ or "usage: outage_stub.py serve|loads|checks|reports|tail\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
