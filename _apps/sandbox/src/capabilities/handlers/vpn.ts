import { join } from "node:path";
import type { CapabilityStatus, VpnConfig } from "@intentic/sandbox-contract";
import { vpnDrivers } from "../../vpn/vpn-drivers.js";
import { connectVpn, disconnectVpn, vpnLink } from "../../vpn/vpn-links.js";
import type { CapabilityHandler } from "../capability.js";

// The `vpn` capability: STORE a connection (credentials + whether it dials itself on boot). Everything about
// dialling lives in the vpn/ subsystem behind a per-protocol driver, and the live surface is the /vpn routes —
// so this handler is only the manifest's half of the story, and the same connect path serves the operator's
// Status card, the agent's `vpn` CLI, this apply, and the boot restore.
//
// The tooling for all three protocols, and the container privileges they need, arrive via this capability's
// environment-overlay fragment + runtime directives, applied by an owner-run rebuild; until then a link reads
// "unavailable". The daemon runs as root, so no sudo is involved.

// ONE fragment for every provider rather than one per protocol. Two reasons, both load-bearing: adding a second
// kind of VPN later must not cost a second container rebuild, and the runtime directives must appear exactly
// once in the composed overlay — rebuild.sh appends each directive token it reads without deduplicating, and a
// doubled --device would fail the run. Composition dedupes fragments by exact content, so N vpn capabilities
// still contribute this one block.
const VPN_FRAGMENT = `# vpn capability: clients for all three supported protocols, plus the container privileges they share.
# WireGuard: wg-quick and the resolvconf its DNS= handling shells out to.
# FortiGate SSL-VPN: openconnect with its vpnc routing script. openconnect routes over tun rather than spawning
#   pppd, so it needs no /dev/ppp — which is why it, not openfortivpn, is the client here.
# IPsec: strongSwan and the extra charon plugins carrying xauth-generic.
RUN apt-get update && apt-get install -y --no-install-recommends \\
        wireguard-tools openresolv openconnect vpnc-scripts strongswan libcharon-extra-plugins \\
    && rm -rf /var/lib/apt/lists/*
# intentic:runtime --device=/dev/net/tun
# intentic:runtime --cap-add=NET_ADMIN`;

const skillDir = (root: string): string => join(root, ".claude", "skills", "vpn");
const skillPath = (root: string): string => join(skillDir(root), "SKILL.md");

// The agent drives VPNs through the `vpn` CLI, never the underlying clients: the CLI calls the daemon, so a
// tunnel the agent dials shows up in the operator's UI (and vice versa) instead of the two drifting apart.
const VPN_SKILL = `---
name: vpn
description: Inspect, connect and disconnect this sandbox's VPN tunnels. Use when the user asks about VPN status, asks to connect or disconnect a VPN, or when a private/internal host, git remote or API is only reachable through a VPN.
---

# VPN tunnels

This sandbox's VPNs are configured by the user (WireGuard, FortiGate SSL-VPN, or IPsec). Use the \`vpn\` command —
it goes through the daemon, so what you do here is what the user sees in the UI, and vice versa.

\`\`\`sh
vpn list                  # every configured VPN, its state, gateway, assigned address and routed networks
vpn status <name>         # one tunnel, same detail
vpn connect <name>        # dial it (prints progress; fails loudly with the reason)
vpn connect <name> --otp 123456   # gateways that ask for a one-time 2FA code
vpn disconnect <name>     # drop it
\`\`\`

While a tunnel is up, routing follows what it pushed — matching traffic just works, with no per-command setup.
\`vpn list\` shows the routed networks, so \`0.0.0.0/0\` means everything is going through the tunnel.

Notes:
- You cannot read a VPN's credentials, and you do not need to: \`vpn connect\` uses the stored ones.
- A one-time code cannot be guessed or stored — if a connect fails asking for one, ask the user for a current code.
- A tunnel marked \`unavailable\` needs a sandbox rebuild (the user does this from Sandbox ▸ Environment); say so
  rather than trying to install a VPN client yourself.
- A tunnel the user set to auto-connect comes back on its own after a sandbox restart — only toggle it when asked.
`;

// A live VPN link mapped onto the capability grid's four states. "connecting" is deliberately `pending` rather
// than `active`: a dial in flight is not yet carrying traffic, and the grid's pending affordance already means
// "not finished".
const capabilityStatus = (state: string, detail: string | undefined): CapabilityStatus => {
    if (state === "connected") {
        return { state: "active" };
    }
    if (state === "connecting") {
        return { state: "pending", detail: "connecting" };
    }
    if (state === "unavailable") {
        return { state: "pending", detail: "rebuild required" };
    }
    if (state === "failed") {
        return { state: "error", ...(detail === undefined ? {} : { detail }) };
    }
    return { state: "inactive" };
};

export const vpnHandler: CapabilityHandler = {
    fragment: () => VPN_FRAGMENT,
    apply: async function* (ctx, id, config) {
        const vpn = config as VpnConfig;
        const entry = { id, config: vpn };
        const driver = vpnDrivers[vpn.provider];
        // Persist the connection first: the manifest entry is what puts the fragment into the overlay, so an
        // add must land even when the tooling isn't installed yet.
        await driver.write(id, vpn);
        await ctx.files.write(skillPath(ctx.workspace.root), VPN_SKILL);
        // Re-applying (an edited credential, an auto-connect flip) must never leave a tunnel running the old
        // config — drop it, then re-dial below if it should be up.
        await disconnectVpn(entry).catch(() => undefined);
        if (vpn.autoConnect !== "on") {
            yield { kind: "log", message: `Stored ${id}. Connect it from the Sandbox ▸ Status card, or ask the agent to.` };
            return;
        }
        const missing = await driver.missingTool();
        if (missing !== undefined) {
            // Pre-rebuild bootstrap: a missing client is a soft outcome, not a failed add — the overlay this
            // very add composes is what installs it.
            yield {
                kind: "log",
                message: `Stored ${id} — this sandbox doesn't carry ${missing} yet. Rebuild it from the Environment card; the tunnel dials itself when it restarts.`,
            };
            return;
        }
        yield* connectVpn(entry);
    },
    status: async (_ctx, id, config) => {
        const link = await vpnLink({ id, config: config as VpnConfig });
        return capabilityStatus(link.state, link.detail);
    },
    remove: async (ctx, id, config) => {
        const vpn = config as VpnConfig;
        await disconnectVpn({ id, config: vpn }).catch(() => undefined);
        await vpnDrivers[vpn.provider].erase(id, vpn);
        // The skill is shared by every vpn — drop it only when this was the last one. The route removes the
        // manifest entry AFTER this handler, so `id` is still counted here.
        const vpnCount = (await ctx.capabilities.list()).filter((capability) => capability.kind === "vpn").length;
        if (vpnCount <= 1) {
            await ctx.files.remove(skillDir(ctx.workspace.root));
        }
    },
};
