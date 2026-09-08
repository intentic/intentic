import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserServerSpec, browserServersOf, isolatedBrowserSpec, writeBrowserConfig } from "./browser-tools.js";
import { type Display, DISPLAY_HEIGHT, DISPLAY_WIDTH } from "../cast/display.js";
import { browserFingerprint } from "../sessions/fingerprint.js";
import { acquireProfileLock, markConnected, releaseProfileLock } from "../sessions/session-store.js";

// Window size travels with the display: the page is exactly the window's content area, no viewport emulation.
const DISPLAY: Display = { name: ":99", width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-tools-"));
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

// Any owner works: these tests check wiring, not device values.
const anyDevice = async (): Promise<Awaited<ReturnType<typeof browserFingerprint>>> => browserFingerprint(tempRoot(), "reddit");

// CI images may lack Chromium; shape assertions stay version-independent regardless.
const chromiumInstalled = async (): Promise<boolean> => Object.keys((await browserServersOf([], tempRoot())).servers).length > 0;

test("browser MCP configs live in a private directory, each one written exclusively", async () => {
    const server = `permissions-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_237, await anyDevice());
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

// Proxy and clock must travel together in one config file; the pairing itself is enforced upstream (fingerprint derived
// from the exit's place).
test("an exit-bound config carries the proxy and the matching clock", async () => {
    const server = `bound-${process.hrtime.bigint()}`;
    const berlin = { locale: "de-DE", timezoneId: "Europe/Berlin", languages: ["de-DE", "de", "en"] };
    const device = await browserFingerprint(tempRoot(), "reddit", berlin);
    const path = await writeBrowserConfig(server, 41_239, device, DISPLAY, {
        exitId: "berlin",
        proxy: "socks5://127.0.0.1:19042",
        country: "DE",
        place: berlin,
    });
    const config = JSON.parse(readFileSync(path, "utf8")) as {
        browser: {
            launchOptions: { proxy?: { server: string } };
            contextOptions: { locale: string; timezoneId: string; extraHTTPHeaders: Record<string, string> };
        };
    };
    expect(config.browser.launchOptions.proxy?.server).toBe("socks5://127.0.0.1:19042");
    expect(config.browser.contextOptions.timezoneId).toBe("Europe/Berlin");
    expect(config.browser.contextOptions.locale).toBe("de-DE");
    // Playwright derives Accept-Language from locale alone; without this it would disagree with the init script.
    expect(config.browser.contextOptions.extraHTTPHeaders["Accept-Language"]).toBe("de-DE,de;q=0.9,en;q=0.8");
});

// viewport: null plus a sized window make click coordinates and the picture one space; --window-position=0,0 pins it
// since Xvfb has no window manager.
test("a headed config sizes the WINDOW and turns viewport emulation off", async () => {
    const server = `windowed-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_241, await anyDevice(), DISPLAY);
    const config = JSON.parse(readFileSync(path, "utf8")) as {
        browser: { launchOptions: { args: string[] }; contextOptions: { viewport?: unknown } };
    };
    expect(config.browser.launchOptions.args).toContain(`--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`);
    expect(config.browser.launchOptions.args).toContain("--window-position=0,0");
    expect(config.browser.contextOptions.viewport).toBeNull();
});

// Headless has no window to size: --window-size would be meaningless, and viewport: null just leaves Chromium's
// default.
test("a headless config sizes no window and leaves the viewport alone", async () => {
    const server = `headless-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_242, await anyDevice());
    const config = JSON.parse(readFileSync(path, "utf8")) as {
        browser: { launchOptions: { args: string[] }; contextOptions: { viewport?: unknown } };
    };
    expect(config.browser.launchOptions.args.some((arg) => arg.startsWith("--window-size"))).toBe(false);
    expect(config.browser.contextOptions.viewport).toBeUndefined();
});

// No proxy key at all when unbound, not an empty one; presence alone would mean something was routed.
test("an unbound config carries no proxy, and still carries the sandbox's clock", async () => {
    const server = `unbound-${process.hrtime.bigint()}`;
    const device = await anyDevice();
    const path = await writeBrowserConfig(server, 41_240, device);
    const config = JSON.parse(readFileSync(path, "utf8")) as {
        browser: { launchOptions: Record<string, unknown>; contextOptions: { locale: string; timezoneId: string } };
    };
    expect(config.browser.launchOptions["proxy"]).toBeUndefined();
    expect(config.browser.contextOptions.locale).toBe(device.locale);
    expect(config.browser.contextOptions.timezoneId).toBe(device.timezoneId);
});

// A reissued port must get its own config file rather than colliding with the old one still on disk (owner+port
// naming).
test("a recycled port writes its own config instead of colliding with the old one", async () => {
    const server = `recycled-${process.hrtime.bigint()}`;
    const device = await anyDevice();
    const first = await writeBrowserConfig(server, 41_237, device);
    const second = await writeBrowserConfig(server, 41_237, device);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(statSync(second).mode & 0o777).toBe(0o600);
});

// Stale config directories from dead daemons are swept; the live one being written now is left alone.
test("config directories left by dead daemons are swept, and the live one is kept", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const dead = mkdtempSync(join(tmpdir(), "intentic-browser-mcp-"));
    const stale = new Date(Date.now() - 7 * 3_600_000);
    writeFileSync(join(dead, "web-40000-abcdef01.json"), "{}");
    utimesSync(join(dead, "web-40000-abcdef01.json"), stale, stale);
    utimesSync(dead, stale, stale);

    const { servers } = await browserServersOf([], tempRoot());

    expect(existsSync(dead)).toBe(false);
    // This turn's own config survives the same sweep pass.
    const args = (servers["web"] as { args: string[] }).args;
    expect(existsSync(args[args.indexOf("--config") + 1] as string)).toBe(true);
});

test("browserServerSpec is a HEADED stdio server bound to the profile + stealth + display", () => {
    const spec = browserServerSpec(
        "cli.js",
        "/ms/chrome",
        `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/reddit`,
        `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/stealth.js`,
        DISPLAY,
        "/tmp/cfg.json",
    ) as {
        type: string;
        command: string;
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.type).toBe("stdio");
    expect(spec.args).toContain("chromium");
    expect(spec.args).toContain("--user-data-dir");
    expect(spec.args).toContain("/work/.intentic/local/browser/reddit");
    expect(spec.args).toContain("--init-script");
    expect(spec.args).toContain("/work/.intentic/local/browser/stealth.js");
    expect(spec.args).toContain("--no-sandbox");
    // The config file carries --remote-debugging-port; that's what makes the browser watchable.
    expect(spec.args).toContain("--config");
    expect(spec.args).toContain("/tmp/cfg.json");
    // Headed, not the fingerprinted headless shell, rendering to the display this browser was given.
    expect(spec.args).not.toContain("--headless");
    expect(spec.env["DISPLAY"]).toBe(":99");
});

// Bounds a single tool call: browser_evaluate awaits an in-page promise that Playwright never times out on its own.
// Per-server, not MCP_TOOL_TIMEOUT, since the same process also serves tools that wait on a person.
test("every browser server bounds a single tool call", () => {
    const specs = [
        browserServerSpec("cli.js", "/ms/chrome", "/profile", "/stealth.js", DISPLAY, "/tmp/cfg.json"),
        isolatedBrowserSpec("cli.js", "/ms/chrome", "/out", "/stealth.js", DISPLAY, "/tmp/cfg.json"),
    ] as { timeout?: number }[];
    for (const spec of specs) {
        expect(spec.timeout).toBeGreaterThan(60_000); // clears @playwright/mcp's own 60s navigation timeout
        expect(spec.timeout).toBeLessThanOrEqual(180_000); // still ends a wedged call within a turn
    }
});

// No identity, so it can exist without login and run two turns at once.
// Still headed and fingerprinted: a WAF blocks headless regardless of login, and SwiftShader is a tell either way.
test("isolatedBrowserSpec keeps the profile in memory and still passes for a real browser", () => {
    const spec = isolatedBrowserSpec(
        "cli.js",
        "/ms/chrome",
        `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`,
        `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/web.stealth.js`,
        DISPLAY,
        "/tmp/cfg.json",
    ) as { args: string[]; env: Record<string, string> };
    expect(spec.args).toContain("--isolated");
    expect(spec.args).not.toContain("--headless");
    expect(spec.args).toContain("--init-script");
    expect(spec.args).toContain("/work/.intentic/local/browser/web.stealth.js");
    expect(spec.args).toContain("--output-dir");
    expect(spec.args).toContain("/work/.intentic/records/artifacts/browser");
    // In memory: no profile on disk to lock, which is what lets two concurrent turns each have one.
    expect(spec.args).not.toContain("--user-data-dir");
    expect(spec.env["DISPLAY"]).toBe(":99");
});

// No Xvfb until an account is connected; falls back to headless rather than failing to look at a URL.
// DISPLAY is stripped, not merely unset: an inherited value would point Chromium at an X server that isn't there.
test("with no display the credential-free browser falls back to headless rather than vanishing", () => {
    const spec = isolatedBrowserSpec("cli.js", "/ms/chrome", "/out", "/stealth.js", undefined, "/tmp/cfg.json") as {
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--isolated");
    expect(spec.env["DISPLAY"]).toBeUndefined();
});

test("a browser is available with no capabilities and no login at all", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    expect(Object.keys((await browserServersOf([], tempRoot())).servers)).toEqual(["web"]);
    const github: Capability = { id: "gh", kind: "cli", config: { provider: "github", token: "x" } };
    expect(Object.keys((await browserServersOf([github], tempRoot())).servers)).toEqual(["web"]);
});

// A pending account's browser still mounts: only the profile lock gates it now, not the connected marker.
// Needs Xvfb like every persisted-profile server; guarded accordingly.
test("a browser capability mounts the ONE routed server before anyone has logged in", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const { servers, accounts, passkeys } = await browserServersOf([reddit], tempRoot());
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts["reddit"]).toBe("reddit");
    // The passkey store is armed from the first page: a sign-up is exactly when the account enrolls its key.
    expect(Object.keys(passkeys)).toContain("reddit");
    // Neither server pins its schemas into the prompt; discovery is one line in the system append.
    expect(servers["browser"]).not.toHaveProperty("alwaysLoad");
    expect(servers["web"]).not.toHaveProperty("alwaysLoad");
});

test("a login in progress suppresses that account's server (the profile is locked)", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(acquireProfileLock("reddit")).toBe(true);
    // The credential-free browser is unaffected: it holds no profile to lock.
    expect(Object.keys((await browserServersOf([reddit], root)).servers)).toEqual(["web"]);
    releaseProfileLock("reddit");
});

// Two accounts of one site are two backends (own --user-data-dir); sharing a dir would fail, Chromium locks it.
// Needs Xvfb like the logged-in path above; guarded the same way.
test("accounts of the same site each get their own backend on their own profile, behind one server", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const root = tempRoot();
    const work: Capability = { id: "reddit-work", kind: "browser", config: { platform: "reddit" } };
    const personal: Capability = { id: "reddit-personal", kind: "browser", config: { platform: "reddit" } };
    await markConnected(root, "reddit-work");
    await markConnected(root, "reddit-personal");

    const { servers, accounts, passkeys } = await browserServersOf([work, personal], root);

    // The prompt pays for one server however many accounts stand behind it.
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts).toEqual({ "reddit-work": "reddit-work", "reddit-personal": "reddit-personal" });
    const routerArgs = (servers["browser"] as { args: string[] }).args;
    const manifest = JSON.parse(readFileSync(routerArgs[1] as string, "utf8")) as {
        accounts: Record<string, string>;
        owners: Record<string, { args: string[] }>;
    };
    expect(manifest.accounts).toEqual(accounts);
    const dirOf = (id: string): string | undefined => {
        const args = manifest.owners[id]?.args ?? [];
        return args[args.indexOf("--user-data-dir") + 1];
    };
    expect(dirOf("reddit-work")).toBe(join(root, ".intentic", "local", "browser", "reddit-work"));
    expect(dirOf("reddit-personal")).toBe(join(root, ".intentic", "local", "browser", "reddit-personal"));
    // Their software security keys are separate too: one account's second factor is not the other's.
    expect(passkeys["reddit-work"]).not.toBe(passkeys["reddit-personal"]);
});

// An identity and an account born from it are one backend (the shared profile), addressable by either id.
test("an identity-born account routes to its identity's browser", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const root = tempRoot();
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const born: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", identity: "main" } };

    const { servers, accounts, ports } = await browserServersOf([main, born], root);
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts).toEqual({ main: "main", "reddit-main": "main" });
    // One profile owner, one debugging port: the observer's map is per owner, not per account.
    expect(Object.keys(ports)).toContain("main");
    expect(ports["reddit-main"]).toBeUndefined();
});

// Without the binary there is nothing to drive, and executablePath() alone never says so.
test("no Chromium on disk means no browser servers at all", async () => {
    if (await chromiumInstalled()) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(await browserServersOf([reddit], root)).toEqual({ servers: {}, accounts: {}, ports: {}, passkeys: {} });
});
