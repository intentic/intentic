import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "@intentic/sandbox-contract";
import { browserOutputDir } from "./browser-artifacts.js";
import { ensureXvfb } from "./display.js";
import { hasSession, isLoginActive, sessionDir } from "./session-store.js";
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
): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [
        cli,
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
    alwaysLoad: true,
});

// The credential-free browser. HEADLESS and `--isolated` (profile in memory): it needs no persisted identity,
// so it needs neither Xvfb nor a --user-data-dir — which also means two concurrent turns can each have one,
// where a shared profile directory would deadlock on Chromium's lock. Screenshots and traces land in the
// workspace under .intentic so the agent can Read them straight back.
export const isolatedBrowserSpec = (cli: string, executablePath: string, outputDir: string): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [
        cli,
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
    // NOT alwaysLoad: @playwright/mcp carries ~20 tools, and pinning them into every turn's prompt taxes the
    // turns that never browse. Deferred, they cost nothing until ToolSearch pulls them in — the system append
    // names the server so the model knows it is there to look for.
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

// Every browser server for this turn. The isolated one is unconditional; a capability's own server is added
// only once it's logged in, and never while a guided login holds the profile (Chromium locks the
// --user-data-dir). A capability may take the `web` id, in which case its persisted profile deliberately wins.
export const browserServersOf = async (capabilities: readonly Capability[], root: string): Promise<Record<string, McpServerConfig>> => {
    const runtime = await browserRuntime();
    if (runtime === undefined) {
        return {};
    }
    const servers: Record<string, McpServerConfig> = {
        web: isolatedBrowserSpec(runtime.cli, runtime.executablePath, browserOutputDir(root)),
    };
    const loggedIn = capabilities.filter(
        (capability) => capability.kind === "browser" && hasSession(root, capability.config.platform) && !isLoginActive(capability.config.platform),
    );
    if (loggedIn.length === 0) {
        return servers;
    }
    // Only the persisted-profile path pays for Xvfb and the stealth script — a turn that never logs in anywhere
    // must not start a virtual display just to have a browser available.
    const display = await ensureXvfb();
    const stealthPath = await ensureStealthScript(root);
    for (const capability of loggedIn) {
        if (capability.kind !== "browser") {
            continue;
        }
        servers[capability.id] = browserServerSpec(
            runtime.cli,
            runtime.executablePath,
            sessionDir(root, capability.config.platform),
            stealthPath,
            display,
        );
    }
    return servers;
};
