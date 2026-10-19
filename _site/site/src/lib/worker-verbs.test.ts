/// <reference types="bun" />
/// <reference types="@intentic/testing/globals" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ONE_LINER_VERBS, type ResolvedOneLiner } from "@intentic/constants";
import { injectPs1, injectSh, isPowerShell, parseVerbRoute, refusalScript, resolveVerbRequest, scriptUrlOf, type VerbRequest } from "./worker-verbs";

const SCRIPTS = resolve(import.meta.dir, "../../public/scripts");
const script = (file: string): string => readFileSync(resolve(SCRIPTS, file), "utf8");

const CURL = "curl/8.4.0";
const PS51 = "Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.19041.3031";
const PWSH = "Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.19041; en-US) PowerShell/7.4.1";

const route = (path: string, ua: string | null = CURL): VerbRequest => {
    const parsed = parseVerbRoute(path, ua);
    if (parsed === undefined) {
        throw new Error(`${path} is not a verb route`);
    }
    return parsed;
};

const ok = (path: string, ua: string | null = CURL): ResolvedOneLiner => {
    const resolved = resolveVerbRequest(route(path, ua));
    if ("error" in resolved) {
        throw new Error(resolved.error);
    }
    return resolved;
};

const refused = (path: string): string => {
    const resolved = resolveVerbRequest(route(path));
    if (!("error" in resolved)) {
        throw new Error(`${path} was served`);
    }
    return resolved.error;
};

// What a request serves, as the Worker composes it.
const serve = (path: string, ua: string | null = CURL): string => {
    const request = route(path, ua);
    const resolved = ok(path, ua);
    return request.shell === "ps1"
        ? injectPs1(script(resolved.files.ps1), resolved)
        : injectSh(script(resolved.files.sh), resolved, scriptUrlOf("intentic.dev", request));
};

describe("shell choice", () => {
    test("PowerShell 5.1 and 7 get ps1, curl and no User-Agent get sh", () => {
        expect(isPowerShell(PS51)).toBe(true);
        expect(isPowerShell(PWSH)).toBe(true);
        expect(isPowerShell(CURL)).toBe(false);
        expect(isPowerShell(null)).toBe(false);
        expect(route("/update/sandbox-abc", PWSH).shell).toBe("ps1");
        expect(route("/update/sandbox-abc", null).shell).toBe("sh");
    });

    test("a trailing .ps1 or .sh on the last segment overrides the User-Agent", () => {
        expect(route("/remove/sandbox-abc.ps1", CURL)).toEqual({ verb: "remove", args: ["sandbox-abc"], shell: "ps1", forced: true });
        expect(route("/remove/sandbox-abc.sh", PWSH)).toEqual({ verb: "remove", args: ["sandbox-abc"], shell: "sh", forced: true });
        expect(route("/remove.ps1", CURL)).toEqual({ verb: "remove", args: [], shell: "ps1", forced: true });
    });

    test("a path whose first segment is no verb is not a verb route", () => {
        expect(parseVerbRoute("/docs/setup", CURL)).toBeUndefined();
        expect(parseVerbRoute("/", CURL)).toBeUndefined();
        expect(parseVerbRoute("/constructor/x", CURL)).toBeUndefined();
    });
});

describe("every verb", () => {
    const cases: readonly [path: string, sh: string, ps1: string, shFile: string][] = [
        ["/setup/Abc123XYZ", "set -- 'Abc123XYZ'", "-SetupCode 'Abc123XYZ'", "connect.sh"],
        ["/setup/Abc123XYZ/my-project", "set -- 'Abc123XYZ'", "-SetupCode 'Abc123XYZ' -SyncDir '~/intentic/my-project'", "connect.sh"],
        ["/fix/Q7XK-2M9P", "set -- 'Q7XK-2M9P'", "-Code 'Q7XK-2M9P'", "fix.sh"],
        ["/update/sandbox-abc", "set -- 'sandbox-abc'", "-Slug 'sandbox-abc'", "recreate.sh"],
        ["/rollback/sandbox-abc", "set -- 'sandbox-abc' '--rollback'", "-Slug 'sandbox-abc' -Rollback", "recreate.sh"],
        ["/restart/sandbox-abc", "set -- 'sandbox-abc' '--restart'", "-Slug 'sandbox-abc' -Restart", "recreate.sh"],
        ["/rebuild/sandbox-abc/0123abcd", "set -- 'sandbox-abc' '0123abcd'", "-Slug 'sandbox-abc' -Hash '0123abcd'", "recreate.sh"],
        ["/remove/sandbox-abc", "set -- 'sandbox-abc' '--yes'", "-Slug 'sandbox-abc' -Yes", "cleanup.sh"],
        ["/remove", "set --", "", "cleanup.sh"],
        ["/uninstall", 'set -- "$@"', "@args", "uninstall.sh"],
        ["/device/sandbox-abc.intentic.app/AB12-CD34", "set -- 'sandbox-abc.intentic.app' 'AB12-CD34'", "-Sandbox 'sandbox-abc.intentic.app' -Code 'AB12-CD34'", "device.sh"],
        ["/sync/sandbox-abc.intentic.app/AB12CD34", "set -- 'sandbox-abc.intentic.app' 'AB12CD34'", "-Sandbox 'sandbox-abc.intentic.app' -Code 'AB12CD34'", "sync.sh"],
        ["/server/box.example.com/AB12CD34", "set -- 'box.example.com' 'AB12CD34'", "-Sandbox 'box.example.com' -Code 'AB12CD34'", "connect-host.sh"],
    ];

    test("the table covers every verb", () => {
        const covered = new Set(cases.map(([path]) => path.split("/")[1]));
        expect([...covered].toSorted()).toEqual([...ONE_LINER_VERBS].toSorted());
    });

    for (const [path, sh, ps1, shFile] of cases) {
        test(`${path} serves ${shFile} with its arguments`, () => {
            expect(ok(path).files.sh).toBe(shFile);
            const shBody = serve(path, CURL);
            expect(shBody.split("\n")[0]).toBe("#!/bin/sh");
            expect(shBody.split("\n")[1]).toBe(sh);
            expect(shBody.split("\n")[2]).toBe(`INTENTIC_SCRIPT_URL='https://intentic.dev${path}'`);
            const psBody = serve(path, PWSH);
            expect(psBody.startsWith("& {\n")).toBe(true);
            expect(psBody.endsWith(ps1 === "" ? "\n}\n" : `\n} ${ps1}\n`)).toBe(true);
        });
    }

    test("uninstall keeps what the person typed after the URL, and every other verb replaces it", () => {
        expect(ok("/uninstall").typed).toBe(true);
        expect(ok("/remove").typed).toBe(false);
        expect(ok("/remove/sandbox-abc").typed).toBe(false);
        expect(serve("/uninstall.ps1", CURL).endsWith("\n} @args\n")).toBe(true);
    });

    test("a sync folder leaf rides as an exported SYNC_DIR line after the URL", () => {
        const lines = serve("/setup/Abc123XYZ/my-project").split("\n");
        expect(lines[3]).toBe("SYNC_DIR='~/intentic/my-project'; export SYNC_DIR");
        expect(lines[4]).not.toContain("SYNC_DIR");
    });

    test("a hostname is lowercased", () => {
        expect(ok("/device/Sandbox-ABC.Intentic.App/AB12CD34").shArgs).toEqual(["sandbox-abc.intentic.app", "AB12CD34"]);
    });
});

describe("refusals", () => {
    test("a hostile argument is refused before anything is served", () => {
        for (const path of [
            "/update/$(reboot)",
            "/update/a'b",
            "/update/sandbox;rm",
            "/update/%27x%27",
            "/fix/abc`id`",
            "/setup/abc def ghi",
            "/remove/..",
            "/device/evil.com'$(id)/AB12CD34",
        ]) {
            expect(refused(path)).toMatch(/^That is not a valid .+\.$/u);
        }
    });

    test("each verb checks its own pattern", () => {
        expect(refused("/setup/short")).toBe("That is not a valid setup code for setup.");
        expect(refused("/setup/Abc123XYZ/My_Folder")).toBe("That is not a valid sync folder for setup.");
        expect(refused("/update/Sandbox")).toBe("That is not a valid sandbox name for update.");
        expect(refused("/rebuild/sandbox-abc/NOTHEX00")).toBe("That is not a valid image hash for rebuild.");
        expect(refused("/device/127.0.0.1/AB12CD34")).toBe("That is not a valid sandbox address for device.");
        expect(refused("/device/localhost/AB12CD34")).toBe("That is not a valid sandbox address for device.");
        expect(refused("/device/host.example.com:8443/AB12CD34")).toBe("That is not a valid sandbox address for device.");
        expect(refused("/sync/host.example.com/AB12")).toBe("That is not a valid code for sync.");
    });

    test("a shell is told why, where `curl -f | sh` and 5.1's irm would hide the 400", () => {
        const sh = refusalScript("sh", "That is not a valid code for device.", "curl/8.5.0");
        expect(sh).toBe(
            "#!/bin/sh\nprintf '%s\\n' 'error: That is not a valid code for device.' '   fix:     copy the command again from intentic: this one was changed on the way.' >&2\nexit 2\n",
        );
        const ps1 = refusalScript("ps1", "update takes a sandbox's name.", "Mozilla/5.0 (Windows NT 10.0) WindowsPowerShell/5.1.26100");
        expect(ps1).toContain("[Console]::Error.WriteLine('error: update takes a sandbox''s name.')");
        expect(ps1).toContain("$global:LASTEXITCODE = 2");
        // Never `exit` under iex: it would close the person's window.
        expect(ps1).not.toMatch(/\bexit\b/u);
        // A browser reads the plain 400 as it is.
        expect(refusalScript("sh", "x", "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0")).toBeUndefined();
        expect(refusalScript("sh", "x", null)).toBeUndefined();
    });

    test("an argument that would reach ic as a flag is refused", () => {
        expect(refused("/fix/--yes")).toBe("That is not a valid fix code for fix.");
        expect(refused("/fix/-y.ps1")).toBe("That is not a valid fix code for fix.");
    });

    test("the wrong number of arguments is refused in one sentence", () => {
        expect(refused("/update")).toBe("update takes a sandbox name.");
        expect(refused("/update/a1/b2")).toBe("update takes a sandbox name.");
        expect(refused("/rebuild/sandbox-abc")).toBe("rebuild takes a sandbox name and an image hash.");
        expect(refused("/remove/sandbox-abc/more")).toBe("remove takes an optional sandbox name.");
        expect(refused("/uninstall/everything")).toBe("uninstall takes nothing after it.");
        expect(refused("/setup")).toBe("setup takes a setup code and an optional sync folder.");
        expect(refused("/server/box.example.com")).toBe("server takes a sandbox address and a code.");
    });
});

describe("injection", () => {
    const resolved = ok("/update/sandbox-abc");

    test("the shebang stays the first line", () => {
        const body = injectSh("#!/bin/sh\nset -eu\necho hi\n", resolved, "https://intentic.dev/update/sandbox-abc");
        expect(body).toBe("#!/bin/sh\nset -- 'sandbox-abc'\nINTENTIC_SCRIPT_URL='https://intentic.dev/update/sandbox-abc'\nset -eu\necho hi\n");
    });

    test("a script without a shebang gets the lines at the very top", () => {
        const body = injectSh("set -eu\necho hi\n", resolved, "https://intentic.dev/update/sandbox-abc");
        expect(body).toBe("set -- 'sandbox-abc'\nINTENTIC_SCRIPT_URL='https://intentic.dev/update/sandbox-abc'\nset -eu\necho hi\n");
    });

    test("a shebang with nothing after it and a CRLF shebang both keep their place", () => {
        expect(injectSh("#!/bin/sh", resolved, "https://x.dev/u").startsWith("#!/bin/sh\nset -- 'sandbox-abc'\n")).toBe(true);
        expect(injectSh("#!/bin/sh\r\necho\r\n", resolved, "https://x.dev/u").startsWith("#!/bin/sh\r\nset -- 'sandbox-abc'\n")).toBe(true);
    });

    test("a typed verb passes the person's own arguments on, after the URL's", () => {
        const typed: ResolvedOneLiner = { ...resolved, typed: true };
        expect(injectSh("#!/bin/sh\necho hi\n", typed, "https://x.dev/u")).toBe(
            "#!/bin/sh\nset -- 'sandbox-abc' \"$@\"\nINTENTIC_SCRIPT_URL='https://x.dev/u'\necho hi\n",
        );
        expect(injectPs1("param([string]$Slug)\n$Slug", typed)).toBe("& {\nparam([string]$Slug)\n$Slug\n} -Slug 'sandbox-abc' @args\n");
    });

    test("a URL that could break the quoting is refused", () => {
        expect(() => injectSh("#!/bin/sh\n", resolved, "https://x.dev/'")).toThrow();
    });

    test("the ps1 param block stays the first statement inside the block", () => {
        for (const file of ["connect.ps1", "recreate.ps1", "cleanup.ps1", "connect-host.ps1", "uninstall.ps1"]) {
            const body = injectPs1(script(file), resolved);
            const inner = body.slice("& {\n".length, body.lastIndexOf("\n}"));
            // Comments (the help block) are not statements; the first code is `param(`.
            const code = inner.replaceAll(/<#[\s\S]*?#>/gu, "").replaceAll(/^\s*#.*$/gmu, "").trimStart();
            expect(code.startsWith("param(")).toBe(true);
        }
    });

    test("a byte-order mark never lands inside the block ahead of param", () => {
        expect(injectPs1("\uFEFFparam([string]$Slug)\n$Slug", resolved)).toBe("& {\nparam([string]$Slug)\n$Slug\n} -Slug 'sandbox-abc'\n");
    });

    test("the re-fetch URL is the canonical https path, keeping a forced shell", () => {
        expect(scriptUrlOf("intentic.dev", route("/update/sandbox-abc/"))).toBe("https://intentic.dev/update/sandbox-abc");
        expect(scriptUrlOf("intentic.dev", route("/update/sandbox-abc.sh"))).toBe("https://intentic.dev/update/sandbox-abc.sh");
    });
});
