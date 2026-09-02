import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserServerSpec, browserServersOf, isolatedBrowserSpec, writeBrowserConfig } from "./browser-tools.js";
import { type Display, DISPLAY_HEIGHT, DISPLAY_WIDTH } from "./display.js";
import { browserFingerprint } from "./fingerprint.js";
import { acquireProfileLock, markConnected, releaseProfileLock } from "./session-store.js";

/* A display, as the launchers now take one rather than a bare DISPLAY string. The size travels with it because
 * it is what the WINDOW is set to: there is no viewport emulation any more, so the page is exactly the window's
 * content area and the picture the owner watches is the window itself (browser/videocast.ts). */
const DISPLAY: Display = { name: ":99", width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-tools-"));
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

// The device a spec is built around. Any owner will do where the test is about wiring rather than values.
const anyDevice = async (): Promise<Awaited<ReturnType<typeof browserFingerprint>>> => browserFingerprint(tempRoot(), "reddit");

// Whether the image actually has Chromium decides what browserServersOf can return, and CI images may not.
// Asserting the SHAPE of each spec is version-independent; the wiring test below adapts.
const chromiumInstalled = async (): Promise<boolean> => Object.keys((await browserServersOf([], tempRoot())).servers).length > 0;

test("browser MCP configs live in a private directory, each one written exclusively", async () => {
    const server = `permissions-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_237, await anyDevice());
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

/* THE TWO HALVES OF A BOUND PROFILE, in the one file that carries both. @playwright/mcp has no flag for
 * either, so the proxy and the clock travel together in this config or not at all — and they must travel
 * TOGETHER: an address in Berlin under a New York clock is a sharper signal than never having moved, because
 * no real visitor looks like that. The pairing is enforced upstream (the fingerprint is derived with the
 * exit's country as its place), and this is where the result becomes a file. */
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
    /* THE THIRD HALF, and the one that is easy to leave out because Playwright appears to handle it. It builds
     * `Accept-Language` from `locale`, so without this line the header would say `de-DE` while the init script
     * told the page `["de-DE","de","en"]`. A German address and a German clock under a header that disagrees
     * with the page's own property is the contradiction the other two lines exist to avoid. */
    expect(config.browser.contextOptions.extraHTTPHeaders["Accept-Language"]).toBe("de-DE,de;q=0.9,en;q=0.8");
});

/* THE WINDOW IS THE VIEWPORT, and both halves of that have to be in the config or the picture is wrong.
 *
 * This used to be `--viewport-size 1280,800` on the command line, which sets the page size through CDP's
 * device-metrics EMULATION: the page is told it is that size whatever the window around it happens to be. That
 * was invisible while the picture came from the page's own compositor, and it is wrong now that the picture is
 * the whole DISPLAY — an emulated viewport inside a differently-sized window renders clipped, so what is
 * grabbed is not what the page thinks it has. `viewport: null` plus a sized window makes them the same thing by
 * construction, which is also what puts the click coordinates and the picture in ONE space.
 *
 * `--window-position=0,0` is as load-bearing as the size: there is no window manager on an Xvfb, so a window
 * lands wherever Chromium asks, and pinning it to the origin is what makes a grab of the screen a grab of
 * exactly this window. */
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

/* …and a HEADLESS one sizes nothing, because it has no window. A `--window-size` there would be a flag about a
 * thing that does not exist, and `viewport: null` would hand the page whatever Chromium's default happens to
 * be rather than a size anything chose. */
test("a headless config sizes no window and leaves the viewport alone", async () => {
    const server = `headless-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_242, await anyDevice());
    const config = JSON.parse(readFileSync(path, "utf8")) as {
        browser: { launchOptions: { args: string[] }; contextOptions: { viewport?: unknown } };
    };
    expect(config.browser.launchOptions.args.some((arg) => arg.startsWith("--window-size"))).toBe(false);
    expect(config.browser.contextOptions.viewport).toBeUndefined();
});

// An unbound profile gets no proxy at all: nothing is routed through an exit unless something asked for it,
// and a `proxy` key present-but-empty would be a different thing entirely.
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

/* THE REGRESSION: a recycled port must not end the turn.
 *
 * Ports are reissued once the port memory has rolled past them: a dozen turns, in a sandbox with twenty
 * accounts, while the config file the earlier turn wrote is still on disk for hours. Named owner+port, the
 * second write hit `wx` and threw EEXIST out of turn planning, killing the turn before the model ran. */
test("a recycled port writes its own config instead of colliding with the old one", async () => {
    const server = `recycled-${process.hrtime.bigint()}`;
    const device = await anyDevice();
    const first = await writeBrowserConfig(server, 41_237, device);
    const second = await writeBrowserConfig(server, 41_237, device);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(statSync(second).mode & 0o777).toBe(0o600);
});

/* Every daemon restart used to leave its config directory behind forever: hundreds of them in a long-lived
 * sandbox. The stale sweep now takes the directories too, without touching the one this process is writing to. */
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
    // …while this turn's own config, in the live directory, survived the very same pass.
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
    // The config file is what carries --remote-debugging-port, and so what makes the browser watchable.
    expect(spec.args).toContain("--config");
    expect(spec.args).toContain("/tmp/cfg.json");
    // Headed, not the fingerprinted headless shell, and rendering to the display this browser was given.
    expect(spec.args).not.toContain("--headless");
    expect(spec.env["DISPLAY"]).toBe(":99");
});

/* The deadline, on both server kinds. Without it a browser tool call is unbounded, and one of these tools
 * genuinely never returns on its own: `browser_evaluate` awaits an in-page promise, which Playwright does not
 * time out, so a page that never reaches the awaited state ends the turn there. It is a PER-SERVER timeout
 * rather than MCP_TOOL_TIMEOUT because the same process serves tools that must wait for a human. */
test("every browser server bounds a single tool call", () => {
    const specs = [
        browserServerSpec("cli.js", "/ms/chrome", "/profile", "/stealth.js", DISPLAY, "/tmp/cfg.json"),
        isolatedBrowserSpec("cli.js", "/ms/chrome", "/out", "/stealth.js", DISPLAY, "/tmp/cfg.json"),
    ] as { timeout?: number }[];
    for (const spec of specs) {
        expect(spec.timeout).toBeGreaterThan(60_000); // clears @playwright/mcp's own 60s navigation timeout
        expect(spec.timeout).toBeLessThanOrEqual(180_000); // …and still ends a wedged call inside a turn
    }
});

/* The credential-free browser carries no identity at all: that is what lets it exist without a login, and what
 * lets two turns run one at once. It is HEADED all the same, because a docs site behind a WAF turns the
 * headless shell away whether or not the visitor is signed in, and it carries the same init script because a
 * SwiftShader GPU is a server tell that has nothing to do with having an account. */
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

/* …but a sandbox whose owner has never connected an account has no Xvfb (it rides the browser capability's
 * Dockerfile fragment), and "read this URL" has to keep working there. No display means headless, and DISPLAY
 * STRIPPED rather than merely absent: an inherited one sends Chromium at an X server that isn't there. */
test("with no display the credential-free browser falls back to headless rather than vanishing", () => {
    const spec = isolatedBrowserSpec("cli.js", "/ms/chrome", "/out", "/stealth.js", undefined, "/tmp/cfg.json") as {
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--isolated");
    expect(spec.env["DISPLAY"]).toBeUndefined();
});

// The regression this whole path exists for: an agent asked to look at a URL used to get NO browser unless the
// owner had logged one into a social platform, so it went and downloaded Chromium by hand.
test("a browser is available with no capabilities and no login at all", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    expect(Object.keys((await browserServersOf([], tempRoot())).servers)).toEqual(["web"]);
    const github: Capability = { id: "gh", kind: "cli", config: { provider: "github", token: "x" } };
    expect(Object.keys((await browserServersOf([github], tempRoot())).servers)).toEqual(["web"]);
});

/* A PENDING account's browser mounts too: over the same persisted profile the guided login would write. This
 * is what lets the agent perform the sign-in (or sign-up) itself and leave the account exactly as connected as
 * a hand login would have; the connected marker gates nothing here any more, only the profile lock does. Needs
 * the virtual display like every persisted-profile server, so guarded like the two-accounts test below. */
test("a browser capability mounts the ONE routed server before anyone has logged in", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const { servers, accounts, passkeys } = await browserServersOf([reddit], tempRoot());
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts["reddit"]).toBe("reddit");
    // The passkey store is armed from the first page: a sign-UP is exactly when the account enrolls its key.
    expect(Object.keys(passkeys)).toContain("reddit");
    /* NEITHER BROWSER PINS ITS SCHEMAS INTO THE PROMPT. The routed one used to, to make itself discoverable,
     * and that cost every turn ~21 tool schemas: over one day of this workspace's sessions all 58 paid for it
     * and 3 used it, while the deferred credential-free browser was used by 25. Discovery moved to one
     * sentence in the system append (agent/system-prompt.ts), which only turns holding an account are told. */
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

/* TWO ACCOUNTS OF ONE SITE ARE TWO BROWSERS behind the ONE routed server, in the same turn. Each backend in
 * the router's manifest gets its own --user-data-dir (which is the fix): pointed at one shared directory they
 * would not merely be confusable, they would be unusable, because Chromium takes an exclusive lock on a
 * profile: the first backend to launch would work and the second would fail on its first call.
 *
 * The logged-in path needs the virtual display, which the sandbox image has and a dev host may not; guarded like
 * the Chromium probe above rather than left to throw somewhere it was never going to run. */
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

    // The prompt pays for ONE server however many accounts stand behind it.
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

// An identity and an account born from it are ONE backend (the shared profile) addressable by either id.
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
