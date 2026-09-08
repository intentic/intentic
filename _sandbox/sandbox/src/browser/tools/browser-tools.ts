import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "@intentic/base/errors";
import type { Capability } from "@intentic/sandbox-contract";
import { workloadStamp } from "../../platform/boot/leftovers.js";
import { freePort as bindEphemeral } from "../../processes/free-port.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import { type ProfileExit, resolveProfileExit } from "../sessions/browser-exit.js";
import { type Display, ensureDisplay } from "../cast/display.js";
import { acceptLanguage, browserFingerprint, type BrowserFingerprint } from "../sessions/fingerprint.js";
import { isProfileOpen, passkeyPath, profileOwner, sessionDir } from "../sessions/session-store.js";
import { ensureStealthScript } from "../sessions/stealth.js";

// Pure wiring over Microsoft's @playwright/mcp; no browser tools of our own.
// `web` is always available, credential-free, in-memory profile (--isolated), for ordinary page reads.
// `browser` fronts every signed-in account/identity via one router, one backend per owner, spawned only when named.

// Router's mount point; the observer keys on this to read a call's `account` arg, not the prefix.
export const ROUTED_BROWSER_SERVER = "browser";

const nodeRequire = createRequire(import.meta.url);
let mcpCli: string | undefined;
// Schema cache key: tool list is a property of the MCP version; filled beside the CLI resolution below.
let mcpVersion = "unknown";

// Resolves the @playwright/mcp CLI from its package.json bin (version-stable, not a hardcoded path).
// Memoized; throws only if the dep is absent.
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

// --remote-debugging-port lets browser-sessions.ts attach; it rides in a --config file, the only seam offered.
// Private per daemon (mkdtemp, 0700, random suffix): a shared /tmp dir would let another user plant a config.
const CONFIG_PREFIX = "intentic-browser-mcp-";
const configDir = mkdtempSync(join(tmpdir(), CONFIG_PREFIX));

// Nothing deletes a config when its Chromium dies; swept on the way in to keep only turns still in flight.
const STALE_CONFIG_MS = 6 * 3_600_000;

// Newest mtime a directory holds, or its own when empty, so an unwritten directory still reads as old eventually.
const freshestMs = async (dir: string): Promise<number> => {
    const own = await stat(dir).catch(() => undefined);
    if (own === undefined) {
        return 0;
    }
    const names = await readdir(dir).catch(() => []);
    const stats = await Promise.all(names.map((name) => stat(join(dir, name)).catch(() => undefined)));
    return Math.max(own.mtimeMs, ...stats.map((entry) => entry?.mtimeMs ?? 0));
};

// Removes config directories dead daemons left behind (mkdtemp per restart, never cleaned) once nothing in them is
// fresh.
// A live-but-idle daemon just rebuilds its dir on its next write.
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

// Issued ports stay unreissued while a bind race could be live; issued is capped so old turns don't linger.
const ISSUED_MEMORY = 256;
const issued: number[] = [];

const freePort = async (): Promise<number> => {
    for (let attempt = 0; attempt < 8; attempt++) {
        const port = await bindEphemeral();
        if (!issued.includes(port)) {
            issued.push(port);
            issued.splice(0, Math.max(0, issued.length - ISSUED_MEMORY));
            return port;
        }
    }
    // Every retry hit an already-issued port; returns one anyway rather than looping, unwatchable but still running.
    return bindEphemeral();
};

// A nonce, not owner+port: a port can recur before its old config file expires, and wx would collide on the name.
// Owner and port stay in the name for reading a directory by eye.
export const writeBrowserConfig = async (
    server: string,
    port: number,
    fingerprint: BrowserFingerprint,
    // Display this browser is headed on, if headed at all; its size becomes the window's, absent means headless.
    display?: Display | undefined,
    exit?: ProfileExit | undefined,
): Promise<string> => {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, `${server}-${port}-${randomBytes(4).toString("hex")}.json`);
    // contextOptions carries clock/language, read before JS runs; Accept-Language is explicit to match languages.
    // viewport: null fills the window instead of CDP emulating a size; window-position pins it for Xvfb.
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

// Points @playwright/mcp at our own installed Chromium via --executable-path, not a pinned dependency version.
// Headed on Xvfb so it isn't fingerprinted as headless; --no-sandbox since the container is the isolation boundary.
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

// --isolated keeps it credential-free and lets concurrent turns each have one, unlike a shared profile directory.
// Headed like the logged-in browsers (a WAF blocks headless regardless of identity); headless only with no display.
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
    // DISPLAY is stripped, not left unset, so a headless Chromium can't inherit one pointing at the wrong X server.
    env:
        display === undefined
            ? (Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DISPLAY")) as Record<string, string>)
            : { ...process.env, DISPLAY: display.name },
    timeout: BROWSER_CALL_TIMEOUT_MS,
    // Not alwaysLoad: tools stay out of the prompt until ToolSearch pulls them in; system append names the server.
});

// Bounds browser_evaluate, which awaits a page promise Playwright never times out on its own.
const BROWSER_CALL_TIMEOUT_MS = 120_000;

// Budget for bringing a bound owner's cold exit up; paid once by the first turn after a cold start.
const EXIT_START_BUDGET_MS = 10_000;

// One router replaces one @playwright/mcp per account, answering startup handshake from a schema cache.
const ROUTER_SCRIPT = fileURLToPath(new URL("../../../bin/browser-router.mjs", import.meta.url));

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
        // executablePath() never throws for a missing browser; existence on disk is the only honest probe.
        return existsSync(executablePath) ? { cli, executablePath } : undefined;
    } catch {
        // @playwright/mcp or playwright missing: no browser tools, rather than breaking the turn.
        return undefined;
    }
};

// Per-turn output: servers, the account-to-owner map behind `browser`, each owner's port, and its passkey store.
// Ports/passkeys ride with servers since watching and passkey arming both key off the same owner.
export interface BrowserTurnTools {
    readonly servers: Record<string, McpServerConfig>;
    // Account or identity id to profile owner; owners map to themselves.
    readonly accounts: Record<string, string>;
    readonly ports: Record<string, number>;
    // Owner to passkey store path; absent for `web`, which holds no identity.
    readonly passkeys: Record<string, string>;
}

// Removes an owner and every account living in its browser, used when its exit or display fails mid-setup.
// The router then refuses that account by name instead of launching it wrong.
const dropOwner = (accounts: Record<string, string>, owner: string): void => {
    delete accounts[owner];
    for (const [id, mapped] of Object.entries(accounts)) {
        if (mapped === owner) {
            delete accounts[id];
        }
    }
};

const NO_BROWSER_TOOLS: BrowserTurnTools = { servers: {}, accounts: {}, ports: {}, passkeys: {} };

// One backend per profile owner, not per account: identities share one with born accounts; two standalone get two.
// `anonymous` controls the separate credential-free browser: a different question from whose name this turn may use.
export const browserServersOf = async (
    capabilities: readonly Capability[],
    root: string,
    anonymous = true,
    // Router's workload stamp for the reaper to claim a hard-killed harness's leftovers; absent on the bench.
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
    // One display per browser, not shared: the pointer is an X-server property, sharing one would overlap windows.
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
    // Router's manifest: every granted id resolves to its profile owner; one held by the login window is left out.
    const accounts: Record<string, string> = {};
    for (const capability of granted) {
        const owner = profileOwner(capability);
        if (owners.has(owner)) {
            accounts[capability.id] = owner;
            accounts[owner] = owner;
        }
    }
    // Logged-in browsers require the display; missing Xvfb stands them down rather than shipping a headless one.
    if (webDisplay === undefined) {
        return { ...NO_BROWSER_TOOLS, servers, ports };
    }
    const backends: Record<string, { command: string; args: readonly string[]; env: Record<string, string> }> = {};
    // A bound exit that won't come up drops its owner, rather than falling back to the sandbox's own address.
    const resolved = new Map(
        await Promise.all(
            [...owners].map(
                async (owner) =>
                    [
                        owner,
                        await resolveProfileExit(capabilities, owner, EXIT_START_BUDGET_MS).catch((error: unknown) => ({
                            refusal: `${owner}: its exit could not be resolved (${errorMessage(error)})`,
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
        // One device per owner (fingerprint.ts); a bound profile's clock matches its exit's country, not the sandbox's.
        const fingerprint = await browserFingerprint(root, owner, exit?.place);
        // This owner's own display; if it can't start, the owner drops, like a refused exit, rather than going
        // headless.
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
        // Only argv and DISPLAY differ; backends inherit the rest, the conversation stamp included, from the router.
        backends[owner] = { command: spec.command, args: spec.args ?? [], env: { DISPLAY: display.name } };
    }
    const manifest = {
        schemaCachePath: join(configDir, `tools-${mcpVersion}.json`),
        // Schema probe: isolated headless server, initialize+tools/list only; depends on the package, not the display.
        probe: {
            command: process.execPath,
            args: [runtime.cli, "--browser", "chromium", "--executable-path", runtime.executablePath, "--no-sandbox", "--isolated", "--headless"],
        },
        accounts,
        owners: backends,
    };
    const manifestPath = join(configDir, `router-${randomBytes(4).toString("hex")}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    // Not alwaysLoad: this router's schemas defer like the credential-free browser's; system append names it.
    servers[ROUTED_BROWSER_SERVER] = {
        type: "stdio",
        command: process.execPath,
        args: [ROUTER_SCRIPT, manifestPath],
        env: {
            ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
            ...(conversationId === undefined ? {} : workloadStamp(conversationId)),
        },
        timeout: BROWSER_CALL_TIMEOUT_MS,
    };
    return { servers, accounts, ports, passkeys };
};
