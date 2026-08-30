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
import { type ProfileExit, resolveProfileExit } from "./browser-exit.js";
import { type Display, ensureDisplay } from "./display.js";
import { acceptLanguage, browserFingerprint, type BrowserFingerprint } from "./fingerprint.js";
import { isProfileOpen, passkeyPath, profileOwner, sessionDir } from "./session-store.js";
import { ensureStealthScript } from "./stealth.js";

// The agent's browser tools come from Microsoft's official @playwright/mcp, we don't reimplement browser
// tools, this is pure wiring. There are two servers, and they exist for different reasons:
//
//   - `web`. ALWAYS available, credential-free, profile in memory (`--isolated`). Reading a page is an
//     ordinary part of coding work: check a docs page, screenshot your own dev server, look at the site you
//     just changed. This used to require a logged-in browser capability, which meant an agent asked to
//     "look at this URL" had no browser at all, and one duly spent a quarter of its turn downloading
//     114 MiB of Chromium through `npx playwright install` to rebuild what was already sitting in the image.
//   - `browser`. ONE server for every signed-in account and identity the turn holds, whose tools each take
//     an `account` parameter (bin/browser-router.mjs). Behind it, one @playwright/mcp backend per PROFILE
//     OWNER, the identity when an account was born from one, the entry itself otherwise, bound to that
//     owner's PERSISTED profile, headed on Xvfb with the stealth patch, spawned only when a call names it.
//     Everything here (the persistence, the anti-fingerprinting) is in service of acting as the owner on a
//     site, including a site the account has NOT signed into yet, because performing that sign-in (or
//     sign-up) is the agent's job too; the accounts tools mark it connected when it lands. One server rather
//     than one per account because the prompt pays per SERVER: N accounts used to pin N copies of the same
//     ~21 tool schemas into every turn.
//
// The server name becomes the tool prefix, so these surface as `mcp__web__browser_*` and
// `mcp__browser__browser_*`.

// The one server name every signed-in browser stands behind, the router's mount point, and the marker the
// observer keys on to read a call's `account` argument instead of the prefix (browser-sessions.ts).
export const ROUTED_BROWSER_SERVER = "browser";

const nodeRequire = createRequire(import.meta.url);
let mcpCli: string | undefined;
// The schema cache's key (bin/browser-router.mjs): the tool list is a property of the @playwright/mcp version,
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
 * The MCP owns its Chromium, it launches it lazily on the first browser tool call and kills it when the turn
 * ends, and that is worth keeping: a turn that never browses starts nothing, and there is no daemon-owned
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

// The newest thing a directory holds, its own mtime when it holds nothing, so a directory nobody has written
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
 * written nothing for the whole stale window, a live-but-idle daemon's would rebuild itself on its next write
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
 * be handed the same number, and that is the one collision that would actually mislead, because the daemon
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
    // Every try came back a port we had already handed out, vanishingly unlikely, and the honest answer is
    // the last one rather than a loop that never ends. The browser still runs; at worst it isn't watchable.
    return bindEphemeral();
};

/* A NONCE, not owner+port, because owner+port REPEATS and the repeat used to end the turn.
 *
 * Ports come back around: freePort refuses to reissue one it remembers, but that memory is the last ISSUED_MEMORY
 * of them, and a turn takes one per profile, a sandbox with twenty accounts burns through the whole memory in a
 * dozen turns, while the files stay readable for STALE_CONFIG_MS. So the kernel hands back a port whose file is
 * still sitting there, `wx` refuses to replace it (rightly, that flag is what stops a planted config naming an
 * executable the child would trust), and the EEXIST propagates out of turn planning, which happens BEFORE the
 * model is asked anything: the whole turn dies with a raw filesystem error and no browser was even involved.
 * The name never had to be derivable, so it isn't. Owner and port stay in it for reading a directory by eye. */
export const writeBrowserConfig = async (
    server: string,
    port: number,
    fingerprint: BrowserFingerprint,
    // The display this browser will be headed on, when it is headed at all. Its size becomes the WINDOW's, see
    // the note on `viewport` below. Absent for a headless one, which has no window to size.
    display?: Display | undefined,
    exit?: ProfileExit | undefined,
): Promise<string> => {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, `${server}-${port}-${randomBytes(4).toString("hex")}.json`);
    /* `contextOptions` is the same seam as `launchOptions` and carries the half of the device that is the
     * CONTEXT's to set rather than the page's: the clock and the language. They cannot go in the init script,
     * because `Accept-Language` and the timezone are read below JavaScript, and a header that disagrees with
     * `navigator.languages` is the kind of contradiction detectors look for first. The owner's own login window
     * passes the identical pair to launchPersistentContext (browser-profile.ts) — they share a profile, so a
     * site must meet the same machine whichever of the two is driving.
     *
     * `Accept-Language` is set EXPLICITLY rather than left to `locale`, which would send only the one tag and
     * contradict the `navigator.languages` the init script installs (see acceptLanguage in fingerprint.ts).
     *
     * `launchOptions.proxy` is the other half of the same file, and the reason a geo exit needs no flag of its
     * own: @playwright/mcp has none for either. The clock above already agrees with it, because the
     * fingerprint this was built from was derived with the exit's country as its place (fingerprint.ts) — an
     * address in Berlin under a New York clock is worse than not having moved at all. */
    /* THE WINDOW IS THE VIEWPORT, and `viewport: null` is what says so. This used to be `--viewport-size
     * 1280,800`, which sets the page size through CDP's device-metrics EMULATION — the page is told it is
     * 1280x800 whatever the window around it happens to be. That was invisible while the picture came from the
     * page's own compositor, and it is wrong now that the picture is the DISPLAY: an emulated viewport inside a
     * differently-sized window renders clipped or letterboxed, so what is grabbed is not what the page thinks
     * it has. Sizing the window and letting the page fill it makes the two the same thing by construction, and
     * it is also what makes the coordinates one space: a point in the captured picture is a point on the
     * display is a point xinput.ts can click.
     *
     * `--window-position=0,0` matters as much as the size. There is no window manager on an Xvfb, so a window
     * lands wherever Chromium asks; pinning it to the origin is what makes the grab of the whole screen a grab
     * of exactly this window. */
    const config = {
        browser: {
            launchOptions: {
                args: [
                    `--remote-debugging-port=${port}`,
                    ...(display === undefined ? [] : ["--window-position=0,0", `--window-size=${display.width},${display.height}`]),
                ],
                ...(exit === undefined ? {} : { proxy: { server: exit.proxy } }),
            },
            contextOptions: {
                ...(display === undefined ? {} : { viewport: null }),
                locale: fingerprint.locale,
                timezoneId: fingerprint.timezoneId,
                extraHTTPHeaders: { "Accept-Language": acceptLanguage(fingerprint.languages) },
            },
        },
    };
    await writeFile(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    return path;
};

// @playwright/mcp bundles its own Playwright, which may expect a different Chromium revision than the one our
// `playwright` dep installed. Instead of pinning the two together, install Chromium via our stable playwright and
// point the MCP at that exact binary with `--executable-path`, one install serves both. HEADED (no --headless)
// on the shared Xvfb via `DISPLAY`, so the browser isn't fingerprinted as a headless bot; `--init-script` loads
// the same stealth patch as the login. `--no-sandbox` because Chromium runs as root and the container IS the
// isolation boundary; `--user-data-dir` is
// the persisted logged-in profile. Runs on the daemon's own node, no PATH/npx lookup.
export const browserServerSpec = (
    cli: string,
    executablePath: string,
    userDataDir: string,
    stealthPath: string,
    display: Display,
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
    ],
    env: { ...process.env, DISPLAY: display.name },
    timeout: BROWSER_CALL_TIMEOUT_MS,
    alwaysLoad: true,
});

/* The credential-free browser. `--isolated` (profile in memory) is what makes it credential-free and what lets
 * two concurrent turns each have one, where a shared profile directory would deadlock on Chromium's lock.
 *
 * IT IS HEADED, on the same Xvfb as the logged-in browsers, and that is a change from what it was. The
 * reasoning that made it headless was that a browser holding no identity has no identity to protect, which is
 * true and beside the point: the headless shell is refused by anti-bot WAFs on sight, and the pages an agent
 * reaches for here are ordinary web pages behind ordinary WAFs. A docs site that answers a logged-in browser
 * and turns this one away is a difference with no reason behind it. It carries the same init script as the
 * others for the same reason — a SwiftShader GPU is a server tell whether or not anyone is signed in.
 *
 * `display` is optional alone in this file: Xvfb rides the browser capability's Dockerfile fragment, so a
 * sandbox that has never connected an account may not have it, and this browser must still work there. Absent,
 * it falls back to headless rather than refusing to exist. Screenshots and traces land in the workspace under
 * .intentic so the agent can Read them straight back. */
export const isolatedBrowserSpec = (
    cli: string,
    executablePath: string,
    outputDir: string,
    stealthPath: string,
    display: Display | undefined,
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
        "--isolated",
        ...(display === undefined ? ["--headless"] : []),
        "--init-script",
        stealthPath,
        "--output-dir",
        outputDir,
    ],
    // With no display, DISPLAY is STRIPPED rather than merely unset: a headless Chromium that inherits one from
    // the daemon's own environment will try to talk to that X server and fail on a display it was never meant
    // to touch.
    env:
        display === undefined
            ? (Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DISPLAY")) as Record<string, string>)
            : { ...process.env, DISPLAY: display.name },
    timeout: BROWSER_CALL_TIMEOUT_MS,
    // NOT alwaysLoad: @playwright/mcp carries ~20 tools, and pinning them into every turn's prompt taxes the
    // turns that never browse. Deferred, they cost nothing until ToolSearch pulls them in, the system append
    // names the server so the model knows it is there to look for.
});

/* WHY A BROWSER TOOL CALL HAS A DEADLINE.
 *
 * @playwright/mcp bounds its own ACTIONS, a click waits 5s for the element, a navigation 60s for the load, and
 * both come back as errors the agent can read and work around. One tool escapes that entirely: `browser_evaluate`
 * hands the page an expression and AWAITS whatever promise it returns, and `page.evaluate` has no timeout in
 * Playwright's API at all (verified: setDefaultTimeout does not reach it). So an in-page wait that never settles
 * is a tool call that never returns, and the turn stops there, no error, no frame, nothing to retry. It is not a
 * hypothetical: a session diagnosing THIS repo's pop-out overlays wrote `while (document.querySelector('.p-popover'))
 * { click(pill); await sleep(150) }` to close a picker before the next probe, against the very bug that stopped
 * the picker from closing. The loop could not terminate, and the turn sat there until the owner killed the
 * browser from /browsers, the one thing that ends it, because destroying the page rejects the pending evaluate.
 *
 * The SDK's per-server `timeout` is the fix at the right level: a hard wall-clock ceiling per tool call, applied
 * to the browser servers alone. It has to be per-server rather than the MCP_TOOL_TIMEOUT env var, because the
 * same agent process holds MCP tools that are SUPPOSED to wait indefinitely, the ones that ask the owner a
 * question and wait for a human to answer. Two minutes clears every legitimate browser call by a wide margin
 * (the slowest bounded thing in there is a 60s navigation) and turns an unbounded stall into an error the agent
 * reads and moves on from. */
const BROWSER_CALL_TIMEOUT_MS = 120_000;

/* HOW LONG TURN SETUP MAY SPEND BRINGING A BOUND OWNER'S GEO EXIT UP. Small on purpose: an exit that is
 * already up costs a probe and never comes near this, so the budget is only ever paid by the FIRST turn after
 * a cold start, and paying it belongs to whichever turn actually wants the browser rather than to every turn.
 *
 * Ten seconds is chosen to split the two cases cleanly. A tunnel provider re-dialling a known server lands
 * inside it, so the common re-start is invisible. A cold tor bootstrap (up to two minutes on its own) does
 * not, so it runs on in the background and the owner rejoins the next turn with the exit already up. */
const EXIT_START_BUDGET_MS = 10_000;

/* THE LAZY PATH for the logged-in browsers, why a turn starts no process per connected account.
 *
 * The harness connects to every configured stdio server at startup and runs the handshake (initialize +
 * tools/list) whether or not the turn ever uses it, verified against the real binary: DEFERRED servers are
 * spawned and handshaken at startup too; deferral only keeps their schemas out of the prompt. One
 * node+playwright process per account meant ~30 processes and ~3.5 GB per turn before the agent said a word,
 * times every concurrent turn, the sandbox's single largest memory load, nearly all of it for browsers nobody
 * would touch that turn.
 *
 * So the harness spawns ONE process, the router (bin/browser-router.mjs): it answers the startup questions
 * from a version-keyed schema cache, and an owner's REAL server, this very spec, is spawned by the router
 * only when a tool call actually names one of that owner's accounts. The specs below therefore describe what
 * the router launches, not what the harness does. Backends are the router's children and the router is the
 * harness's, so the turn ending is the whole teardown; the workload stamp on the router's environment lets
 * the reaper claim anything a hard-killed harness left behind. */
const ROUTER_SCRIPT = fileURLToPath(new URL("../../bin/browser-router.mjs", import.meta.url));

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
        // @playwright/mcp or playwright absent, contribute no browser tools rather than break the turn.
        return undefined;
    }
};

// What one turn gets: the MCP servers themselves, the account→owner map behind the `browser` server, the
// debugging port each owner's Chromium was told to open, and each owner's passkey store. The ports travel with
// the servers because they are the same decision, a browser the agent can drive and a browser the owner can
// watch have to be the same browser (browser-sessions.ts holds the other end); the passkey stores ride the
// same map because the observer that watches those pages is also what plugs the account's software security
// key into them (passkeys.ts). `accounts` is the same map the router enforces with, exported so the session
// hooks and the secrets tool resolve a call's `account` argument to a profile exactly the way the router does.
export interface BrowserTurnTools {
    readonly servers: Record<string, McpServerConfig>;
    // Account or identity id → the profile owner whose browser it lives in. Owners map to themselves.
    readonly accounts: Record<string, string>;
    readonly ports: Record<string, number>;
    // Owner → that profile's passkey store path. Absent for `web`, the credential-free browser holds no identity.
    readonly passkeys: Record<string, string>;
}

/* Take an owner out of the routing table, and every account that lives in its browser with it. Used for the two
 * reasons an owner can be dropped mid-setup — an exit that would not come up, a display that would not start —
 * because in both cases the browser would otherwise be launched wrong rather than not at all, and the router's
 * "no such account" is the refusal the agent should read. */
const dropOwner = (accounts: Record<string, string>, owner: string): void => {
    delete accounts[owner];
    for (const [id, mapped] of Object.entries(accounts)) {
        if (mapped === owner) {
            delete accounts[id];
        }
    }
};

const NO_BROWSER_TOOLS: BrowserTurnTools = { servers: {}, accounts: {}, ports: {}, passkeys: {} };

// The turn's browser servers. An account is included whether or not it has signed in yet, a PENDING account's
// backend runs over the very same persisted profile the guided login would write, which is what lets the agent
// perform the sign-in (or sign-up) itself and leave the account exactly as connected as a hand login would
// have. The one gate left is the profile lock: never while the owner's own window holds it (Chromium locks the
// --user-data-dir).
//
// One backend PER PROFILE OWNER behind the one `browser` server, keyed by profileOwner's answer, the identity
// when an account was born from one, the entry itself otherwise. Two standalone accounts of one site
// (reddit-work, reddit-personal) are two backends over two separate profiles, both drivable in the same turn;
// an identity and every account born from it are ONE backend over the shared profile, because they are one
// browser and Chromium locks the --user-data-dir. The accounts map is also what lets a turn granted only
// `reddit-work` (not its identity) still act: the account names its shared browser by itself, keyed by the
// identity's id.
//
// `anonymous` is the credential-free browser, the persona shelf of the same name, and the reason this is a
// parameter rather than the unconditional server it used to be. It is asked separately from the accounts above
// because it is a different question: that one is "whose name may this turn use", this one is "may it read the
// web at all", and a persona that reads docs pages while touching nobody's account is an ordinary answer.
export const browserServersOf = async (
    capabilities: readonly Capability[],
    root: string,
    anonymous = true,
    // The conversation the turn belongs to, the router's workload stamp, so the reaper can claim anything a
    // hard-killed harness left behind. Absent (the bench) the router simply runs unstamped.
    conversationId?: string,
): Promise<BrowserTurnTools> => {
    const runtime = await browserRuntime();
    if (runtime === undefined) {
        return NO_BROWSER_TOOLS;
    }
    await sweepConfigs(Date.now());
    const ports: Record<string, number> = {};
    const passkeys: Record<string, string> = {};
    const servers: Record<string, McpServerConfig> = {};
    /* A DISPLAY PER BROWSER, not one shared by all of them, which is a change and the reason display.ts now
     * takes a key. Headed is the point of having one at all (the headless shell is fingerprinted and turned
     * away), but the display is now also the PICTURE: the view routes grab it as video and drive its pointer,
     * and a pointer is a property of the X server rather than of a window, so two browsers sharing a display
     * would share one cursor and overlap each other's windows. See display.ts.
     *
     * Asked for even by a turn that logs into nothing, because the credential-free browser is headed too.
     * Failure is not fatal: Xvfb rides the browser capability's Dockerfile fragment, so a sandbox whose owner
     * has never connected an account has none, and "read this URL" must keep working there. `undefined` sends
     * the isolated browser back to headless; the logged-in path, which cannot fall back (its whole job is to
     * pass for a person), refuses below instead. */
    const webDisplay = await ensureDisplay("web").catch(() => undefined);
    if (anonymous) {
        const webPort = await freePort();
        ports["web"] = webPort;
        const fingerprint = await browserFingerprint(root, "web");
        servers["web"] = isolatedBrowserSpec(
            runtime.cli,
            runtime.executablePath,
            browserOutputDir(root),
            await ensureStealthScript(root, "web", fingerprint),
            webDisplay,
            await writeBrowserConfig("web", webPort, fingerprint, webDisplay),
        );
    }
    const granted = capabilities.filter((capability) => capability.kind === "browser" || capability.kind === "identity");
    const owners = new Set(granted.map((capability) => profileOwner(capability)).filter((owner) => !isProfileOpen(owner)));
    if (owners.size === 0) {
        return { ...NO_BROWSER_TOOLS, servers, ports };
    }
    /* The router's manifest: every granted account or identity id resolves to the profile owner whose browser
     * it lives in, owners map to themselves, so an identity id names its own browser and a standalone account
     * its own. An id whose owner's profile is held open by the user's own login window is left out with it: the
     * router's refusal then says so instead of a backend fighting Chromium for the lock. */
    const accounts: Record<string, string> = {};
    for (const capability of granted) {
        const owner = profileOwner(capability);
        if (owners.has(owner)) {
            accounts[capability.id] = owner;
            accounts[owner] = owner;
        }
    }
    /* The logged-in path REQUIRES the display, where the credential-free one merely prefers it. Its whole job
     * is to act as a person on a site that is watching for one, and the headless shell is the single loudest
     * way to fail that, so a missing Xvfb stands the logged-in browsers down (the agent still has `web`, and
     * the Environment card is where the owner installs the pack) rather than quietly shipping a browser that
     * every WAF turns away. */
    if (webDisplay === undefined) {
        return { ...NO_BROWSER_TOOLS, servers, ports };
    }
    const backends: Record<string, { command: string; args: readonly string[]; env: Record<string, string> }> = {};
    /* A profile BOUND TO A GEO EXIT is resolved before anything is spawned, and an exit that cannot be brought
     * up DROPS THE OWNER from this turn rather than degrading. That is the whole point of the binding: an
     * account set to browse from Berlin must never quietly browse from this sandbox's own address instead, and
     * a backend spawned without the proxy would do exactly that. The router's refusal for a missing account is
     * what the agent then reads.
     *
     * RESOLVED ALL AT ONCE, AND ON A BUDGET, because this runs on the turn's critical path, before every turn,
     * for every bound owner, whether or not the turn goes near a browser. Serially and unbounded it was the
     * slowest thing in turn setup by a wide margin: three bound owners on cold tor exits could hold a turn that
     * only wanted to edit a file for several minutes. Neither half of the fix loses the guarantee, a start that
     * outlives its budget carries on in the background (startExitOnce) and the next turn joins or finds it up,
     * and an owner whose exit is not up yet is simply absent from this turn. */
    const resolved = new Map(
        await Promise.all(
            [...owners].map(
                async (owner) =>
                    [
                        owner,
                        await resolveProfileExit(capabilities, owner, EXIT_START_BUDGET_MS).catch((error: unknown) => ({
                            refusal: `${owner}: its exit could not be resolved (${error instanceof Error ? error.message : String(error)})`,
                        })),
                    ] as const,
            ),
        ),
    );
    for (const owner of owners) {
        const bound = resolved.get(owner);
        if (bound !== undefined && "refusal" in bound) {
            dropOwner(accounts, owner);
            continue;
        }
        const exit = bound?.exit;
        const port = await freePort();
        ports[owner] = port;
        passkeys[owner] = passkeyPath(root, owner);
        /* One device per owner, derived (fingerprint.ts) rather than shared: the GPU string is the signal that
         * survives an IP change, so handing every profile the same one would link an owner's accounts for free.
         *
         * The exit's country goes in as the device's PLACE, which is the same rule fingerprint.ts already
         * follows rather than an exception to it: the clock and the language belong to the address traffic
         * leaves by, and a bound profile's address is the exit's, not the sandbox's. Unbound, `place` is
         * undefined and the sandbox's own clock answers, as it does for everyone else. */
        const fingerprint = await browserFingerprint(root, owner, exit?.place);
        /* THIS OWNER'S OWN DISPLAY, so the browser the user later watches is alone on the thing being
         * photographed. An owner whose display cannot be started is dropped from the turn exactly as a refused
         * exit drops one: a logged-in browser with nowhere headed to run is a headless one, and headless is
         * what these accounts exist to avoid. */
        const display = await ensureDisplay(owner).catch(() => undefined);
        if (display === undefined) {
            dropOwner(accounts, owner);
            continue;
        }
        const spec = browserServerSpec(
            runtime.cli,
            runtime.executablePath,
            sessionDir(root, owner),
            await ensureStealthScript(root, owner, fingerprint),
            display,
            await writeBrowserConfig(owner, port, fingerprint, display, exit),
        );
        if (spec.type !== "stdio") {
            return { ...NO_BROWSER_TOOLS, servers, ports };
        }
        // Argv and the DISPLAY delta only, never the whole environment: the backends inherit the rest, the
        // conversation stamp included, from the router at spawn time.
        backends[owner] = { command: spec.command, args: spec.args ?? [], env: { DISPLAY: display.name } };
    }
    const manifest = {
        schemaCachePath: join(configDir, `tools-${mcpVersion}.json`),
        // The schema probe: an isolated headless server, initialize + tools/list and gone. The tool list is a
        // property of the MCP package, not of any launch flag, profile, display and ports shape the browser,
        // never the tool surface.
        probe: {
            command: process.execPath,
            args: [runtime.cli, "--browser", "chromium", "--executable-path", runtime.executablePath, "--no-sandbox", "--isolated", "--headless"],
        },
        accounts,
        owners: backends,
    };
    const manifestPath = join(configDir, `router-${randomBytes(4).toString("hex")}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    /* The one server the harness spawns for every signed-in browser: the router, whose tools are pinned into
     * the prompt ONCE (alwaysLoad) however many accounts stand behind them, a model that does not know it can
     * act as its accounts never will. Same per-call ceiling as the backends it launches. */
    servers[ROUTED_BROWSER_SERVER] = {
        type: "stdio",
        command: process.execPath,
        args: [ROUTER_SCRIPT, manifestPath],
        env: {
            ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(conversationId === undefined ? {} : workloadStamp(conversationId)),
        },
        timeout: BROWSER_CALL_TIMEOUT_MS,
        alwaysLoad: true,
    };
    return { servers, accounts, ports, passkeys };
};
