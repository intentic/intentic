import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserServerSpec, browserServersOf } from "./browser-tools.js";
import { acquireLoginLock, markConnected, releaseLoginLock } from "./session-store.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-tools-"));
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

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

// The gating short-circuits before touching Xvfb/Chromium, so these run without a browser installed.
test("no logged-in browser capability → no MCP servers", async () => {
    const github: Capability = { id: "gh", kind: "cli", config: { provider: "github", token: "x" } };
    expect(await browserServersOf([], "/work")).toEqual({});
    expect(await browserServersOf([github], "/work")).toEqual({});
    // Present but not logged in yet.
    expect(await browserServersOf([reddit], tempRoot())).toEqual({});
});

test("a login in progress suppresses that platform's server (the profile is locked)", async () => {
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(acquireLoginLock("reddit")).toBe(true);
    expect(await browserServersOf([reddit], root)).toEqual({});
    releaseLoginLock("reddit");
});
