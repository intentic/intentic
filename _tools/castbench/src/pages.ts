import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Serves the workload pages and the viewer page on loopback, both bundled from this package's source as the server
// starts, so the marker code the pages paint with and the viewer reads with is the one file the tests cover. Loopback
// http is a secure context, which WebCodecs needs.

export interface PageServer {
    readonly origin: string;
    readonly close: () => Promise<void>;
}

const WORKLOAD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>castbench</title>
<style>body{margin:0;font:16px/1.5 sans-serif;background:#fff;color:#222}#content{max-width:1100px;margin:64px auto 0;padding:0 24px}</style>
</head><body><canvas id="marker"></canvas><div id="content"></div><script type="module" src="/workload.js"></script></body></html>`;

const VIEWER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>castbench viewer</title></head><body><script type="module" src="/decoder.js"></script></body></html>`;

const bundle = async (entry: string): Promise<string> => {
    const built = await Bun.build({ entrypoints: [new URL(entry, import.meta.url).pathname], target: "browser", conditions: ["@intentic/src"] });
    const [output] = built.outputs;
    if (!built.success || output === undefined) {
        throw new Error(`could not bundle ${entry}: ${built.logs.map(String).join("; ")}`);
    }
    return output.text();
};

export const startPageServer = async (): Promise<PageServer> => {
    const scripts = {
        "/decoder.js": await bundle("./client/decoder.ts"),
        "/workload.js": await bundle("./pages/workload.ts"),
    };
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path === "/decoder.js" || path === "/workload.js") {
            response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
            response.end(scripts[path]);
            return;
        }
        if (path === "/viewer" || path.startsWith("/workload/")) {
            response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
            response.end(path === "/viewer" ? VIEWER_HTML : WORKLOAD_HTML);
            return;
        }
        response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: listening on a TCP port, so the address is an AddressInfo.
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
};
