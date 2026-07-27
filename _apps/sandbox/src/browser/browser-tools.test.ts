import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserServerSpec, browserServersOf, isolatedBrowserSpec } from "./browser-tools.js";
import { acquireLoginLock, markConnected, releaseLoginLock } from "./session-store.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-tools-"));
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

// Whether the image actually has Chromium decides what browserServersOf can return, and CI images may not.
// Asserting the SHAPE of each spec is version-independent; the wiring test below adapts.
const chromiumInstalled = async (): Promise<boolean> => Object.keys(await browserServersOf([], tempRoot())).length > 0;

test("browserServerSpec is a HEADED stdio server bound to the profile + stealth + display", () => {
    const spec = browserServerSpec("cli.js", "/ms/chrome", "/work/.intentic/browser/reddit", "/work/.intentic/browser/stealth.js", ":99") as {
        type: string;
        command: string;
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.type).toBe("stdio");
    expect(spec.args).toContain("chromium");
    expect(spec.args).toContain("--user-data-dir");
    expect(spec.args).toContain("/work/.intentic/browser/reddit");
    expect(spec.args).toContain("--init-script");
    expect(spec.args).toContain("/work/.intentic/browser/stealth.js");
    expect(spec.args).toContain("--no-sandbox");
    // Headed, not the fingerprinted headless shell, and rendering to the shared Xvfb.
    expect(spec.args).not.toContain("--headless");
    expect(spec.env.DISPLAY).toBe(":99");
});

// The credential-free browser carries no identity at all — that is what lets it exist without a login, and
// what lets two turns run one at once.
test("isolatedBrowserSpec keeps the profile in memory and needs no display", () => {
    const spec = isolatedBrowserSpec("cli.js", "/ms/chrome", "/work/.intentic/browser/output") as {
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--output-dir");
    expect(spec.args).toContain("/work/.intentic/browser/output");
    expect(spec.args).not.toContain("--user-data-dir");
    expect(spec.args).not.toContain("--init-script");
    expect(spec.env["DISPLAY"]).toBeUndefined();
});

// The regression this whole path exists for: an agent asked to look at a URL used to get NO browser unless the
// owner had logged one into a social platform, so it went and downloaded Chromium by hand.
test("a browser is available with no capabilities and no login at all", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    expect(Object.keys(await browserServersOf([], tempRoot()))).toEqual(["web"]);
    const github: Capability = { id: "gh", kind: "cli", config: { provider: "github", token: "x" } };
    expect(Object.keys(await browserServersOf([github], tempRoot()))).toEqual(["web"]);
});

// Only the not-logged-in half is assertable here: the logged-in path starts Xvfb, which exists in the sandbox
// image and not on a dev host, so driving it from a unit test would just hang.
test("a browser capability contributes nothing extra until it is logged in", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    expect(Object.keys(await browserServersOf([reddit], tempRoot()))).toEqual(["web"]);
});

test("a login in progress suppresses that platform's server (the profile is locked)", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(acquireLoginLock("reddit")).toBe(true);
    // The credential-free browser is unaffected — it holds no profile to lock.
    expect(Object.keys(await browserServersOf([reddit], root))).toEqual(["web"]);
    releaseLoginLock("reddit");
});

// Without the binary there is nothing to drive, and executablePath() alone never says so.
test("no Chromium on disk means no browser servers at all", async () => {
    if (await chromiumInstalled()) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(await browserServersOf([reddit], root)).toEqual({});
});
