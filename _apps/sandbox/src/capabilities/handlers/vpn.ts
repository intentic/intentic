import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VpnConfig } from "@intentic/sandbox-contract";
import { shellQuote } from "../../terminal/terminal-run.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

// A VPN capability: route the agent's traffic through a WireGuard tunnel. One capability = one tunnel; the id
// is the wg interface name (the contract caps it at IFNAMSIZ). `apply` writes the pasted .conf 0600 under
// ~/.wireguard and — when enabled — brings the tunnel up with `wg-quick up <path>` (wg-quick derives the
// interface from the filename, so the conf never needs to live in /etc/wireguard). WireGuard tooling and the
// container privileges it needs (NET_ADMIN + /dev/net/tun) arrive via this capability's environment-overlay
// fragment + runtime directives, applied by an owner-run rebuild; until then the entry reports "pending".
// The daemon runs as root, so no sudo is involved.

const exec = promisify(execFile);

// The composed-overlay fragment: WireGuard tooling plus the runtime directives the rebuild executors translate
// into docker run flags (allowlisted there — see rebuild.sh / the workspace provider).
const VPN_FRAGMENT = `# vpn capability: WireGuard tooling (wg-quick) + the resolvconf its DNS= handling calls.
RUN apt-get update && apt-get install -y --no-install-recommends wireguard-tools openresolv \\
    && rm -rf /var/lib/apt/lists/*
# intentic:runtime --device=/dev/net/tun
# intentic:runtime --cap-add=NET_ADMIN`;

// Computed from homedir() at call time (not cached) so a test can point HOME at a temp dir, like the ssh handler.
const baseDir = (): string => join(homedir(), ".wireguard");
const confPath = (id: string): string => join(baseDir(), `${id}.conf`);
const skillDir = (root: string): string => join(root, ".claude", "skills", "vpn");
const skillPath = (root: string): string => join(skillDir(root), "SKILL.md");

// Tunnel probes tolerate failure: "already down" and a missing wg binary both reduce to the state we can
// observe, not an error to surface.
const isUp = async (id: string): Promise<boolean> =>
    exec("wg", ["show", id]).then(
        () => true,
        () => false,
    );
// ENOENT on spawn ⇒ the binary isn't on PATH (rebuild not run yet). Any other outcome (including wg-quick's
// non-zero usage exit) means it exists.
const wgQuickMissing = async (): Promise<boolean> =>
    exec("wg-quick", ["--help"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
// Visible teardown in the capability's job session; any failure ("already down", missing binary, no conf dir
// yet) is a tolerated outcome, not an error. cwd is the conf dir — the only path the command touches.
const down = async (ctx: CapabilityCtx, id: string): Promise<void> => {
    await ctx.terminalRun
        .tryRun(capabilityJobSession(id), `wg-quick down ${shellQuote(confPath(id))}`, { cwd: baseDir(), window: "wg-down" })
        .catch(() => undefined);
};

const VPN_SKILL = `---
name: vpn
description: Check or toggle the connected WireGuard VPN tunnels. Use when the user asks about VPN status, to connect/disconnect the VPN, or when a private/internal host is only reachable through the VPN.
---

# VPN tunnels (WireGuard)

Each connected VPN is a WireGuard config in \`~/.wireguard/<name>.conf\`; the tunnel interface is \`<name>\`.
Routing follows the config's AllowedIPs — while the tunnel is up, matching traffic just works, no per-command setup.

- List configured VPNs: \`ls ~/.wireguard/*.conf\`
- Tunnel status (handshake, transfer): \`wg show <name>\`
- Bring a tunnel up: \`wg-quick up ~/.wireguard/<name>.conf\` — down: \`wg-quick down ~/.wireguard/<name>.conf\`

Note: a tunnel the user enabled comes back up on its own after a sandbox restart — only toggle it when asked.
`;

export const vpnHandler: CapabilityHandler = {
    fragment: () => VPN_FRAGMENT,
    apply: async function* (ctx, id, config) {
        const vpn = config as VpnConfig;
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        await mkdir(baseDir(), { recursive: true, mode: 0o700 });
        await writeFile(confPath(id), vpn.config.endsWith("\n") ? vpn.config : `${vpn.config}\n`, { mode: 0o600 });
        await ctx.files.write(skillPath(ctx.workspace.root), VPN_SKILL);
        // Re-applying (an edit or an on/off flip) must not leave a stale interface running the old conf.
        await down(ctx, id);
        if (vpn.enabled === "off") {
            yield { kind: "log", message: `Stored ${id} switched off. Re-add it with the connection on to bring the tunnel up.` };
            return;
        }
        // Pre-rebuild bootstrap: the add must still land in the manifest (that's what puts the fragment into
        // the overlay), so a missing wg-quick is a soft outcome, not a failure. A real `up` failure still throws.
        if (await wgQuickMissing()) {
            yield {
                kind: "log",
                message: `Stored ${id} — this sandbox doesn't carry WireGuard yet. Rebuild it from the Environment card; the tunnel comes up automatically when it restarts.`,
            };
            return;
        }
        yield { kind: "log", message: `Bringing up WireGuard tunnel ${id}…` };
        // The conf path (not its contents — the keys stay in the 0600 file) is all the visible command carries.
        await ctx.terminalRun.run(session, `wg-quick up ${shellQuote(confPath(id))}`, { cwd: baseDir(), window: "wg-up" });
        yield { kind: "log", message: `Connected ${id}. The agent's traffic now follows the tunnel's AllowedIPs.` };
    },
    status: async (_ctx, id, config) => {
        if (await isUp(id)) {
            return { state: "active" };
        }
        if ((await readFile(confPath(id), "utf8").catch(() => undefined)) === undefined) {
            return { state: "inactive" };
        }
        if ((config as VpnConfig).enabled !== "on") {
            return { state: "inactive" };
        }
        // Conf present, enabled, no interface: either the tooling hasn't been rebuilt in yet, or the tunnel died.
        if (await wgQuickMissing()) {
            return { state: "pending", detail: "rebuild required" };
        }
        return { state: "error", detail: "tunnel down" };
    },
    remove: async (ctx, id) => {
        await down(ctx, id);
        await rm(confPath(id), { force: true });
        // The skill is shared by every vpn — drop it only when this was the last one. The route removes the
        // manifest entry AFTER this handler, so `id` is still counted here.
        const vpnCount = (await ctx.capabilities.list()).filter((capability) => capability.kind === "vpn").length;
        if (vpnCount <= 1) {
            await ctx.files.remove(skillDir(ctx.workspace.root));
        }
    },
};

// Boot reconnect: tunnel state dies with the container while the manifest survives on /work, so main.ts calls
// this once at startup to restore every tunnel the user left enabled. Best-effort — a dead VPN server must not
// take the daemon down; the failure lands in status ("tunnel down") and the log.
export const reconnectVpns = async (ctx: CapabilityCtx): Promise<void> => {
    for (const capability of await ctx.capabilities.list()) {
        if (capability.kind !== "vpn" || capability.config.enabled !== "on" || (await isUp(capability.id))) {
            continue;
        }
        try {
            await exec("wg-quick", ["up", confPath(capability.id)]);
            ctx.logger.info(`vpn ${capability.id}: tunnel restored`);
        } catch (error) {
            ctx.logger.warn(`vpn ${capability.id}: could not restore the tunnel: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};
