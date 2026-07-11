import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "@intentic/sandbox-contract";
import { ensureXvfb } from "./display.js";
import { hasSession, isLoginActive, sessionDir } from "./session-store.js";
import { ensureStealthScript } from "./stealth.js";

// The agent's browser tools come from Microsoft's official @playwright/mcp, spawned per turn as a stdio MCP
// server bound to the platform's persisted (logged-in) Chromium profile — the parallel to mcpToolsOf for the
// browser path. One server per active, logged-in browser capability; the server name is the capability id, so
// its tools surface as `mcp__<id>__browser_*`. We don't reimplement browser tools — this is pure wiring.

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
// the same stealth patch as the login. `--no-sandbox` because the container is unprivileged; `--user-data-dir` is
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

// A browser capability contributes tools only once it's logged in, and never while a guided login holds the
// profile (Chromium locks the --user-data-dir). Async because it resolves the installed Chromium's path, ensures
// the virtual display is up, and writes the stealth script the MCP loads.
export const browserServersOf = async (capabilities: readonly Capability[], root: string): Promise<Record<string, McpServerConfig>> => {
    const ready = (capability: Capability): boolean =>
        capability.kind === "browser" && hasSession(root, capability.config.platform) && !isLoginActive(capability.config.platform);
    if (!capabilities.some(ready)) {
        return {};
    }
    let cli: string;
    let executablePath: string;
    let stealthPath: string;
    let display: string;
    try {
        cli = resolveMcpCli();
        const { chromium } = await import("playwright");
        executablePath = chromium.executablePath();
        display = await ensureXvfb();
        stealthPath = await ensureStealthScript(root);
    } catch {
        // @playwright/mcp / Chromium / Xvfb not installed yet (the sandbox hasn't been rebuilt for a browser
        // capability) — contribute no browser tools rather than break the turn; status() tells the owner to rebuild.
        return {};
    }
    return Object.fromEntries(
        capabilities.flatMap((capability) =>
            capability.kind === "browser" && hasSession(root, capability.config.platform) && !isLoginActive(capability.config.platform)
                ? [
                      [
                          capability.id,
                          browserServerSpec(cli, executablePath, sessionDir(root, capability.config.platform), stealthPath, display),
                      ] as const,
                  ]
                : [],
        ),
    );
};
