import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "@intentic/sandbox-contract";
import { workloadStamp } from "../platform/leftovers.js";
import { browserOutputDir } from "./browser-artifacts.js";
import { ensureXvfb } from "./display.js";
import { isProfileOpen, passkeyPath, profileOwner, sessionDir } from "./session-store.js";
import { ensureStealthScript } from "./stealth.js";

// The agent's browser tools come from Microsoft's official @playwright/mcp, one stdio MCP server per turn per
// kind — though for the account kind what the harness spawns is a thin bridge, and the real server starts only
// when a tool call actually arrives (see THE LAZY PATH below). We don't reimplement browser tools — this is
// pure wiring. There are two kinds, and they exist for different reasons:
//
//   - `web` — ALWAYS available, credential-free, profile in memory (`--isolated`). Reading a page is an
//     ordinary part of coding work: check a docs page, screenshot your own dev server, look at the site you
//     just changed. This used to require a logged-in browser capability, which meant an agent asked to
//     "look at this URL" had no browser at all — and one duly spent a quarter of its turn downloading
//     114 MiB of Chromium through `npx playwright install` to rebuild what was already sitting in the image.
//   - one per browser CAPABILITY (account) — bound to that account's PERSISTED profile, headed on Xvfb with
//     the stealth patch. Everything here (the persistence, the anti-fingerprinting) is in service of acting
//     as the owner on a site — including a site the account has NOT signed into yet, because performing that
//     sign-in (or sign-up) is now the agent's job too; the accounts tools mark it connected when it lands.
//
// The server name becomes the tool prefix, so these surface as `mcp__web__browser_*` and
// `mcp__<capability-id>__browser_*`.

const nodeRequire = createRequire(import.meta.url);
let mcpCli: string | undefined;
// The schema cache's key (bin/browser-mux.mjs): the tool list is a property of the @playwright/mcp version,
// so a cached answer outlives every turn and dies with an upgrade. Filled beside the CLI resolution below.
let mcpVersion = "unknown";

// Resolve the @playwright/mcp CLI from its package.json `bin` (path is version-stable via the manifest, not a
// hardcoded internal file). Memoized; throws only if the dep is absent (then browserServersOf yields none).
const resolveMcpCli = (): string => {
    if (mcpCli !== undefined) {
        return mcpCli;
    }
    const pkgJsonPath = nodeRequire.resolve("@playwright/mcp/package.json");
    const pkg = nodeRequire("@playwright/mcp/package.json") as { bin: string | Record<string, string>; version?: string };
    const rel = typeof pkg.bin === "string" ? pkg.bin : (Object.values(pkg.bin)[0] ?? "cli.js");
    mcpVersion = pkg.version ?? "unknown";
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
// Private per daemon process: configs name executables and arguments the child will trust, so a shared /tmp
// directory would let another local user pre-create or replace one before the MCP reads it. mkdtemp creates
// this with mode 0700 and an unpredictable suffix; every file below is exclusive and 0600 as the second half.
const CONFIG_PREFIX = "intentic-browser-mcp-";
const configDir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));

// A config file's whole life is one turn's Chromium, but nothing deletes it when that Chromium dies (the MCP
// is not ours to hook). Sweeping the dir on the way in keeps it to the handful of turns in flight, without a
// timer or a shutdown path that a crash would skip anyway.
const STALE_CONFIG_MS = 6 * 3_600_000;

// The newest thing a directory holds — its own mtime when it holds nothing, so a directory nobody has written
// to since it was created still reads as old once it is.
const freshestMs = async (dir: string): Promise<number> => {
    const own = await stat(dir).catch(() => undefined);
    if (own === undefined) {
        return 0;
    }
    const names = await readdir(dir).catch(() => []);
    const stats = await Promise.all(names.map((name) => stat(join(dir, name)).catch(() => undefined)));
    return Math.max(own.mtimeMs, ...stats.map((entry) => entry?.mtimeMs ?? 0));
};

/* The DIRECTORY itself outlives its daemon, and nothing was removing it: mkdtemp per process, one per restart,
 * kept forever. A long-lived sandbox accumulated hundreds of them, a couple of dozen files deep each. So the
 * same pass that trims stale files inside our own directory also removes the directories of daemons that have
 * written nothing for the whole stale window — a live-but-idle daemon's would rebuild itself on its next write
 * (mkdir below restores the 0700), and its mux sockets are long dead by then anyway. */
const sweepDeadDirs = async (now: number): Promise<void> => {
    const parent = tmpdir();
    const names = await readdir(parent).catch(() => []);
    await Promise.all(
        names
            .filter((name) => name.startsWith(CONFIG_PREFIX) && join(parent, name) !== configDir)
            .map(async (name) => {
                const dir = join(parent, name);
                if ((await freshestMs(dir)) <= now - STALE_CONFIG_MS) {
                    await rm(dir, { recursive: true, force: true });
                }
            }),
    );
};

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
    await sweepDeadDirs(now);
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

/* A NONCE, not owner+port, because owner+port REPEATS and the repeat used to end the turn.
 *
 * Ports come back around: freePort refuses to reissue one it remembers, but that memory is the last ISSUED_MEMORY
 * of them, and a turn takes one per profile — a sandbox with twenty accounts burns through the whole memory in a
 * dozen turns, while the files stay readable for STALE_CONFIG_MS. So the kernel hands back a port whose file is
 * still sitting there, `wx` refuses to replace it (rightly — that flag is what stops a planted config naming an
 * executable the child would trust), and the EEXIST propagates out of turn planning, which happens BEFORE the
 * model is asked anything: the whole turn dies with a raw filesystem error and no browser was even involved.
 * The name never had to be derivable, so it isn't. Owner and port stay in it for reading a directory by eye. */
export const writeBrowserConfig = async (server: string, port: number): Promise<string> => {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, `${server}-${port}-${randomBytes(4).toString("hex")}.json`);
    await writeFile(path, JSON.stringify({ browser: { launchOptions: { args: [`--remote-debugging-port=${port}`] } } }), {
        flag: "wx",
        mode: 0o600,
    });
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

/* THE LAZY PATH for the logged-in browsers — why a turn no longer starts one process per connected account.
 *
 * The harness connects to every configured stdio server at startup and runs the handshake (initialize +
 * tools/list) whether or not the turn ever uses it — verified against the real binary: DEFERRED servers are
 * spawned and handshaken at startup too; deferral only keeps their schemas out of the prompt. One
 * node+playwright process per account meant ~30 processes and ~3.5 GB per turn before the agent said a word,
 * times every concurrent turn — the sandbox's single largest memory load, nearly all of it for browsers nobody
 * would touch that turn.
 *
 * So the per-account server is now a ~1 MB socat bridge into ONE per-turn mux (bin/browser-mux.mjs, a daemon
 * child): the mux answers the startup questions from a version-keyed schema cache, and the account's REAL
 * server — this very spec — is spawned by the mux only when a tool call actually arrives for it. The specs
 * below therefore describe what the mux launches, not what the harness does.
 *
 * The mux is stamped with the conversation like every other turn workload, so the reaper's ordinary rules own
 * it; each backend additionally dies the moment its bridge closes — i.e. with its turn. Everything degrades to
 * the eager spec (fail-open): no socat in the image, no mux beside this build, or a turn with no conversation
 * behind it (the bench), and the harness simply spawns the account servers directly as it always did. */
const MUX_SCRIPT = fileURLToPath(new URL("../../bin/browser-mux.mjs", import.meta.url));
const SOCAT_PATHS = ["/usr/bin/socat", "/usr/local/bin/socat"];
const muxAvailable = (): string | undefined => (existsSync(MUX_SCRIPT) ? SOCAT_PATHS.find((path) => existsSync(path)) : undefined);

// The bridge the harness actually spawns for one account: a byte pipe into the mux's per-account socket. Same
// per-call timeout and the same alwaysLoad as the real server, because from the SDK's side this IS the server —
// the tools stay in the prompt exactly as before; alwaysLoad's startup handshake now lands on the mux, which
// answers it without a browser process anywhere.
const bridgeSpec = (socat: string, socket: string): McpServerConfig => ({
    type: "stdio",
    command: socat,
    args: ["STDIO", `UNIX-CONNECT:${socket}`],
    timeout: BROWSER_CALL_TIMEOUT_MS,
    alwaysLoad: true,
});

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
// watches those pages is also what plugs the account's software security key into them (passkeys.ts).
export interface BrowserTurnTools {
    readonly servers: Record<string, McpServerConfig>;
    readonly ports: Record<string, number>;
    // Server id → that account's passkey store path. Absent for `web` — the credential-free browser holds no identity.
    readonly passkeys: Record<string, string>;
}

// Every browser server for this turn. A capability's own server is added whether or not the account has signed
// in yet — a PENDING account's server runs over the very same persisted profile the guided login would write,
// which is what lets the agent perform the sign-in (or sign-up) itself and leave the account exactly as
// connected as a hand login would have. The one gate left is the profile lock: never while the owner's own
// window holds it (Chromium locks the --user-data-dir). A capability may take the `web` id, in which case its
// persisted profile deliberately wins.
//
// One server PER PROFILE OWNER, keyed by profileOwner's answer — the identity when an account was born from
// one, the entry itself otherwise. Two standalone accounts of one site (reddit-work, reddit-personal) are two
// servers over two separate profiles, both drivable in the same turn; an identity and every account born from
// it are ONE server over the shared profile, because they are one browser and Chromium locks the
// --user-data-dir. The dedup is also what lets a turn granted only `reddit-work` (not its identity) still act:
// the account brings its shared browser up by itself, keyed by the identity's id.
//
// `anonymous` is the credential-free browser — the persona shelf of the same name, and the reason this is a
// parameter rather than the unconditional server it used to be. It is asked separately from the accounts above
// because it is a different question: that one is "whose name may this turn use", this one is "may it read the
// web at all", and a persona that reads docs pages while touching nobody's account is an ordinary answer.
export const browserServersOf = async (
    capabilities: readonly Capability[],
    root: string,
    anonymous = true,
    // The conversation the turn belongs to — the mux's workload stamp. Absent (the bench) keeps the eager path:
    // a lazy fleet nothing could reap is worse than the spawn it saves.
    conversationId?: string,
): Promise<BrowserTurnTools> => {
    const runtime = await browserRuntime();
    if (runtime === undefined) {
        return { servers: {}, ports: {}, passkeys: {} };
    }
    await sweepConfigs(Date.now());
    const ports: Record<string, number> = {};
    const passkeys: Record<string, string> = {};
    const servers: Record<string, McpServerConfig> = {};
    if (anonymous) {
        const webPort = await freePort();
        ports["web"] = webPort;
        servers["web"] = isolatedBrowserSpec(runtime.cli, runtime.executablePath, browserOutputDir(root), await writeBrowserConfig("web", webPort));
    }
    const owners = new Set(
        capabilities
            .filter((capability) => capability.kind === "browser" || capability.kind === "identity")
            .map((capability) => profileOwner(capability))
            .filter((owner) => !isProfileOpen(owner)),
    );
    if (owners.size === 0) {
        return { servers, ports, passkeys };
    }
    // Only the persisted-profile path pays for Xvfb and the stealth script — a turn that never logs in anywhere
    // must not start a virtual display just to have a browser available.
    const display = await ensureXvfb();
    const stealthPath = await ensureStealthScript(root);
    const specs: Record<string, McpServerConfig> = {};
    for (const owner of owners) {
        const port = await freePort();
        ports[owner] = port;
        passkeys[owner] = passkeyPath(root, owner);
        specs[owner] = browserServerSpec(
            runtime.cli,
            runtime.executablePath,
            sessionDir(root, owner),
            stealthPath,
            display,
            await writeBrowserConfig(owner, port),
        );
    }
    const socat = muxAvailable();
    const lazy =
        socat !== undefined && conversationId !== undefined ? await startBrowserMux(specs, { display, conversationId, socat, runtime }) : undefined;
    return { servers: { ...servers, ...(lazy ?? specs) }, ports, passkeys };
};

/* Launch the per-turn mux and answer with the bridge specs — or undefined when it could not come up, which
 * hands the caller back the eager specs (fail-open, the tmux-run posture). The manifest carries argv and the
 * DISPLAY delta only, never the environment: the mux is a daemon child and its backends inherit the rest —
 * the conversation stamp included — at spawn time. */
const startBrowserMux = async (
    specs: Readonly<Record<string, McpServerConfig>>,
    context: { readonly display: string; readonly conversationId: string; readonly socat: string; readonly runtime: BrowserRuntime },
): Promise<Record<string, McpServerConfig> | undefined> => {
    const nonce = randomBytes(4).toString("hex");
    const owners: Record<string, { socket: string; command: string; args: readonly string[]; env: Record<string, string> }> = {};
    const bridges: Record<string, McpServerConfig> = {};
    let index = 0;
    for (const [owner, spec] of Object.entries(specs)) {
        if (spec.type !== "stdio") {
            return undefined;
        }
        // Socket paths must clear the 108-char sun_path ceiling, so the owner rides in the manifest, not the name.
        const socket = join(configDir, `s-${nonce}-${index}.sock`);
        index += 1;
        owners[owner] = { socket, command: spec.command, args: spec.args ?? [], env: { DISPLAY: context.display } };
        bridges[owner] = bridgeSpec(context.socat, socket);
    }
    const manifest = {
        schemaCachePath: join(configDir, `tools-${mcpVersion}.json`),
        // The schema probe: an isolated headless server, initialize + tools/list and gone. The tool list is a
        // property of the MCP package, not of any launch flag — profile, display and ports shape the browser,
        // never the tool surface.
        probe: {
            command: process.execPath,
            args: [
                context.runtime.cli,
                "--browser",
                "chromium",
                "--executable-path",
                context.runtime.executablePath,
                "--no-sandbox",
                "--isolated",
                "--headless",
            ],
        },
        owners,
    };
    const manifestPath = join(configDir, `mux-${nonce}.json`);
    try {
        await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
        const mux = spawn(process.execPath, [MUX_SCRIPT, manifestPath], {
            env: { ...process.env, ...workloadStamp(context.conversationId) },
            stdio: ["ignore", "ignore", "ignore"],
        });
        mux.on("error", () => undefined);
        mux.unref();
        /* The harness dials the bridges as soon as its CLI boots, and a socat that finds no listener exits —
         * the harness would file that account's server as failed for the whole turn. The listeners appear as
         * socket FILES in one synchronous pass of the mux's startup, so their presence is awaited here, briefly:
         * a mux that produced no sockets within the window has plainly died, and the eager specs take over. */
        const last = Object.values(owners).at(-1)?.socket;
        if (last !== undefined) {
            for (let waited = 0; ; waited += 50) {
                if (existsSync(last)) {
                    break;
                }
                if (waited >= 3_000 || mux.exitCode !== null) {
                    return undefined;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        return bridges;
    } catch {
        return undefined;
    }
};
