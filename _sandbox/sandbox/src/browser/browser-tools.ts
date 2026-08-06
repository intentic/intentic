import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "@intentic/sandbox-contract";
import { browserOutputDir } from "./browser-artifacts.js";
import { ensureXvfb } from "./display.js";
import { hasSession, isLoginActive, passkeyPath, sessionDir } from "./session-store.js";
import { ensureStealthScript } from "./stealth.js";

// The agent's browser tools come from Microsoft's official @playwright/mcp, spawned per turn as stdio MCP
// servers. We don't reimplement browser tools — this is pure wiring. There are two kinds, and they exist for
// different reasons:
//
//   - `web` — ALWAYS available, credential-free, profile in memory (`--isolated`). Reading a page is an
//     ordinary part of coding work: check a docs page, screenshot your own dev server, look at the site you
//     just changed. This used to require a logged-in browser capability, which meant an agent asked to
//     "look at this URL" had no browser at all — and one duly spent a quarter of its turn downloading
//     114 MiB of Chromium through `npx playwright install` to rebuild what was already sitting in the image.
//   - one per logged-in browser CAPABILITY — bound to that platform's PERSISTED profile, headed on Xvfb with
//     the stealth patch. Everything here (the login, the persistence, the anti-fingerprinting) is in service
//     of acting as the owner on a site they authenticated to, which is why it stays gated on that login.
//
// The server name becomes the tool prefix, so these surface as `mcp__web__browser_*` and
// `mcp__<capability-id>__browser_*`.

const nodeRequire = createRequire(import.meta.url);
let mcpCli: string | undefined;

// Resolve the @playwright/mcp CLI from its package.json `bin` (path is version-stable via the manifest, not a
// hardcoded internal file). Memoized; throws only if the dep is absent (then browserServersOf yields none).
const resolveMcpCli = (): string => {
    if (mcpCli !== undefined) {
        return mcpCli;
    }
    const pkgJsonPath = nodeRequire.resolve("@playwright/mcp/package.json");
    const bin = (nodeRequire("@playwright/mcp/package.json") as { bin: string | Record<string, string> }).bin;
    const rel = typeof bin === "string" ? bin : (Object.values(bin)[0] ?? "cli.js");
    mcpCli = join(dirname(pkgJsonPath), rel);
    return mcpCli;
};

/* WHY EVERY BROWSER IS LAUNCHED WITH A DEBUGGING PORT.
 *
 * The MCP owns its Chromium — it launches it lazily on the first browser tool call and kills it when the turn
 * ends — and that is worth keeping: a turn that never browses starts nothing, and there is no daemon-owned
 * process to leak. So instead of taking the browser over, we ask for a window into it: `--remote-debugging-port`
 * makes Chromium ALSO listen on loopback TCP (Playwright drives it over a pipe, so the two don't collide), and
 * browser-sessions.ts attaches there to watch. Without this one flag the agent's browser is unobservable.
 *
 * It has to travel in a CONFIG FILE because @playwright/mcp has no flag for browser args; `browser.launchOptions`
 * in a `--config` file is the documented seam, and the CLI's own flags are merged over it (config first, flags
 * last), so everything below still wins where the two overlap. */
const configDir = join(tmpdir(), "intentic-browser-mcp");

// A config file's whole life is one turn's Chromium, but nothing deletes it when that Chromium dies (the MCP
// is not ours to hook). Sweeping the dir on the way in keeps it to the handful of turns in flight, without a
// timer or a shutdown path that a crash would skip anyway.
const STALE_CONFIG_MS = 6 * 3_600_000;
const sweepConfigs = async (now: number): Promise<void> => {
    const entries = await readdir(configDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
        entries.map(async (entry) => {
            const path = join(configDir, entry.name);
            const stats = await stat(path).catch(() => undefined);
            if (stats !== undefined && stats.mtimeMs <= now - STALE_CONFIG_MS) {
                await rm(path, { force: true });
            }
        }),
    );
};

/* A free loopback port, taken by binding one and letting go.
 *
 * The gap between letting go and Chromium's own bind is where a second turn planned in the same moment could
 * be handed the same number — and that is the one collision that would actually mislead, because the daemon
 * would attach to whichever browser won the race and screencast the WRONG turn's browsing. So issued ports are
 * remembered and never offered twice while they could still be in flight; the kernel's own reuse guard covers
 * the rest. `issued` is bounded because a long-lived sandbox would otherwise accumulate one number per turn
 * forever, and a port from hundreds of turns ago is not a port anyone is racing for. */
const ISSUED_MEMORY = 256;
const issued: number[] = [];

const bindEphemeral = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
        });
    });

const freePort = async (): Promise<number> => {
    for (let attempt = 0; attempt < 8; attempt++) {
        const port = await bindEphemeral();
        if (!issued.includes(port)) {
            issued.push(port);
            issued.splice(0, Math.max(0, issued.length - ISSUED_MEMORY));
            return port;
        }
    }
    // Every try came back a port we had already handed out — vanishingly unlikely, and the honest answer is
    // the last one rather than a loop that never ends. The browser still runs; at worst it isn't watchable.
    return bindEphemeral();
};

const writeBrowserConfig = async (server: string, port: number): Promise<string> => {
    await mkdir(configDir, { recursive: true });
    const path = join(configDir, `${server}-${port}.json`);
    await writeFile(path, JSON.stringify({ browser: { launchOptions: { args: [`--remote-debugging-port=${port}`] } } }));
    return path;
};

// @playwright/mcp bundles its own Playwright, which may expect a different Chromium revision than the one our
// `playwright` dep installed. Instead of pinning the two together, install Chromium via our stable playwright and
// point the MCP at that exact binary with `--executable-path` — one install serves both. HEADED (no --headless)
// on the shared Xvfb via `DISPLAY`, so the browser isn't fingerprinted as a headless bot; `--init-script` loads
// the same stealth patch as the login. `--no-sandbox` because Chromium runs as root and the container IS the
// isolation boundary; `--user-data-dir` is
// the persisted logged-in profile. Runs on the daemon's own node — no PATH/npx lookup.
export const browserServerSpec = (
    cli: string,
    executablePath: string,
    userDataDir: string,
    stealthPath: string,
    display: string,
    configPath: string,
): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [
        cli,
        "--config",
        configPath,
        "--browser",
        "chromium",
        "--executable-path",
        executablePath,
        "--no-sandbox",
        "--user-data-dir",
        userDataDir,
        "--init-script",
        stealthPath,
        "--viewport-size",
        "1280,800",
    ],
    env: { ...process.env, DISPLAY: display },
    timeout: BROWSER_CALL_TIMEOUT_MS,
    alwaysLoad: true,
});

// The credential-free browser. HEADLESS and `--isolated` (profile in memory): it needs no persisted identity,
// so it needs neither Xvfb nor a --user-data-dir — which also means two concurrent turns can each have one,
// where a shared profile directory would deadlock on Chromium's lock. Screenshots and traces land in the
// workspace under .intentic so the agent can Read them straight back.
export const isolatedBrowserSpec = (cli: string, executablePath: string, outputDir: string, configPath: string): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [
        cli,
        "--config",
        configPath,
        "--browser",
        "chromium",
        "--executable-path",
        executablePath,
        "--no-sandbox",
        "--isolated",
        "--headless",
        "--output-dir",
        outputDir,
        "--viewport-size",
        "1280,800",
    ],
    // DISPLAY is stripped, not merely unset: a headless Chromium that inherits one from the daemon's own
    // environment will try to talk to that X server and fail on a display it was never meant to touch.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DISPLAY")) as Record<string, string>,
    timeout: BROWSER_CALL_TIMEOUT_MS,
    // NOT alwaysLoad: @playwright/mcp carries ~20 tools, and pinning them into every turn's prompt taxes the
    // turns that never browse. Deferred, they cost nothing until ToolSearch pulls them in — the system append
    // names the server so the model knows it is there to look for.
});

/* WHY A BROWSER TOOL CALL HAS A DEADLINE.
 *
 * @playwright/mcp bounds its own ACTIONS — a click waits 5s for the element, a navigation 60s for the load, and
 * both come back as errors the agent can read and work around. One tool escapes that entirely: `browser_evaluate`
 * hands the page an expression and AWAITS whatever promise it returns, and `page.evaluate` has no timeout in
 * Playwright's API at all (verified: setDefaultTimeout does not reach it). So an in-page wait that never settles
 * is a tool call that never returns, and the turn stops there — no error, no frame, nothing to retry. It is not a
 * hypothetical: a session diagnosing THIS repo's pop-out overlays wrote `while (document.querySelector('.p-popover'))
 * { click(pill); await sleep(150) }` to close a picker before the next probe, against the very bug that stopped
 * the picker from closing. The loop could not terminate, and the turn sat there until the owner killed the
 * browser from /browsers — the one thing that ends it, because destroying the page rejects the pending evaluate.
 *
 * The SDK's per-server `timeout` is the fix at the right level: a hard wall-clock ceiling per tool call, applied
 * to the browser servers alone. It has to be per-server rather than the MCP_TOOL_TIMEOUT env var, because the
 * same agent process holds MCP tools that are SUPPOSED to wait indefinitely — the ones that ask the owner a
 * question and wait for a human to answer. Two minutes clears every legitimate browser call by a wide margin
 * (the slowest bounded thing in there is a 60s navigation) and turns an unbounded stall into an error the agent
 * reads and moves on from. */
const BROWSER_CALL_TIMEOUT_MS = 120_000;

// What both server kinds need before either can run.
interface BrowserRuntime {
    readonly cli: string;
    readonly executablePath: string;
}

const browserRuntime = async (): Promise<BrowserRuntime | undefined> => {
    try {
        const cli = resolveMcpCli();
        const { chromium } = await import("playwright");
        const executablePath = chromium.executablePath();
        // executablePath() DERIVES a path from the bundled Chromium revision and returns it whether or not the
        // download ever ran, so it throws for a missing browser exactly never. Its existence is the only honest
        // probe, and without it the MCP would spawn and fail on the first navigate instead of standing down here.
        return existsSync(executablePath) ? { cli, executablePath } : undefined;
    } catch {
        // @playwright/mcp or playwright absent — contribute no browser tools rather than break the turn.
        return undefined;
    }
};

// What one turn gets: the MCP servers themselves, the debugging port each one's Chromium was told to open, and
// each logged-in server's passkey store. The ports travel with the servers because they are the same decision —
// a browser the agent can drive and a browser the owner can watch have to be the same browser
// (browser-sessions.ts holds the other end); the passkey stores ride the same map because the observer that
// watches those pages is also what plugs the platform's software security key into them (passkeys.ts).
export interface BrowserTurnTools {
    readonly servers: Record<string, McpServerConfig>;
    readonly ports: Record<string, number>;
    // Server id → the platform's passkey store path. Absent for `web` — the credential-free browser holds no identity.
    readonly passkeys: Record<string, string>;
}

// Every browser server for this turn. The isolated one is unconditional; a capability's own server is added
// only once it's logged in, and never while a guided login holds the profile (Chromium locks the
// --user-data-dir). A capability may take the `web` id, in which case its persisted profile deliberately wins.
export const browserServersOf = async (capabilities: readonly Capability[], root: string): Promise<BrowserTurnTools> => {
    const runtime = await browserRuntime();
    if (runtime === undefined) {
        return { servers: {}, ports: {}, passkeys: {} };
    }
    await sweepConfigs(Date.now());
    const webPort = await freePort();
    const ports: Record<string, number> = { web: webPort };
    const passkeys: Record<string, string> = {};
    const servers: Record<string, McpServerConfig> = {
        web: isolatedBrowserSpec(runtime.cli, runtime.executablePath, browserOutputDir(root), await writeBrowserConfig("web", webPort)),
    };
    const loggedIn = capabilities.filter(
        (capability) => capability.kind === "browser" && hasSession(root, capability.config.platform) && !isLoginActive(capability.config.platform),
    );
    if (loggedIn.length === 0) {
        return { servers, ports, passkeys };
    }
    // Only the persisted-profile path pays for Xvfb and the stealth script — a turn that never logs in anywhere
    // must not start a virtual display just to have a browser available.
    const display = await ensureXvfb();
    const stealthPath = await ensureStealthScript(root);
    for (const capability of loggedIn) {
        if (capability.kind !== "browser") {
            continue;
        }
        const port = await freePort();
        ports[capability.id] = port;
        passkeys[capability.id] = passkeyPath(root, capability.config.platform);
        servers[capability.id] = browserServerSpec(
            runtime.cli,
            runtime.executablePath,
            sessionDir(root, capability.config.platform),
            stealthPath,
            display,
            await writeBrowserConfig(capability.id, port),
        );
    }
    return { servers, ports, passkeys };
};
