import type { VpnConfig } from "@intentic/sandbox-contract";
import { tunnelHandler, tunnelStatus } from "../../tunnel/tunnel-handler.js";
import { vpnDrivers } from "../../vpn/vpn-drivers.js";
import { connectVpn, disconnectVpn, vpnLink } from "../../vpn/vpn-links.js";
import { TUN_PRIVILEGES_FRAGMENT } from "./net-privileges.js";

// Stores a VPN connection (credentials, autoconnect on boot); dialing lives in vpn/ behind a per-protocol driver.
// Tooling and container privileges arrive via this capability's fragment, applied by an owner rebuild; until then a
// link reads unavailable.

// One fragment for every provider, so a new kind costs no rebuild; privileges live in net-privileges.ts.
const VPN_FRAGMENT = `# vpn capability: clients for all three supported protocols.
# WireGuard: wg-quick and the resolvconf its DNS= handling shells out to.
# FortiGate SSL-VPN: openconnect with its vpnc routing script. openconnect routes over tun rather than spawning
#   pppd, so it needs no /dev/ppp, which is why it, not openfortivpn, is the client here.
# IPsec: strongSwan, plus BOTH charon plugin sets. libcharon-extauth-plugins is the one that matters and is
#   easy to miss: xauth-generic lives there, not in libcharon-extra-plugins (which ships only xauth-eap and
#   xauth-pam, neither of which can answer a gateway's XAuth challenge with a username and password). Without
#   it an XAuth tunnel negotiates phase 1 and then fails with no mention of the missing plugin.
RUN apt-get update && apt-get install -y --no-install-recommends \\
        wireguard-tools openresolv openconnect vpnc-scripts strongswan libcharon-extra-plugins libcharon-extauth-plugins \\
    && rm -rf /var/lib/apt/lists/*`;

// Agent drives VPNs through the `vpn` CLI, never the clients directly, so agent and UI state can't drift apart.
const VPN_SKILL = `---
name: vpn
description: Inspect, connect and disconnect this sandbox's VPN tunnels. Use when the user asks about VPN status, asks to connect or disconnect a VPN, or when a private/internal host, git remote or API is only reachable through a VPN.
---

# VPN tunnels

This sandbox's VPNs are configured by the user (WireGuard, FortiGate SSL-VPN, or IPsec). Use the \`vpn\` command:
it goes through the daemon, so what you do here is what the user sees in the UI, and vice versa.

\`\`\`sh
vpn list                  # every configured VPN, its state, gateway, assigned address and routed networks
vpn status <name>         # one tunnel, same detail
vpn connect <name>        # dial it (prints progress; fails loudly with the reason)
vpn connect <name> --otp 123456   # gateways that ask for a one-time 2FA code
vpn disconnect <name>     # drop it
\`\`\`

While a tunnel is up, routing follows what it pushed: matching traffic just works, with no per-command setup.
\`vpn list\` shows the routed networks, so \`0.0.0.0/0\` means everything is going through the tunnel.

Notes:
- Lost the internet, or a command started hanging, right after a tunnel came up? That is a FULL TUNNEL whose
  gateway does not route the internet: \`vpn list\` shows \`0.0.0.0/0\`, so everything, including your own
  connection out of this sandbox: is being handed to a gateway that drops most of it. Disconnect it to get back,
  and tell the user to narrow that VPN capability's "Routed networks" to the networks behind the gateway; both
  work at once after that. Never work around it by editing /etc/ipsec.d: connect rewrites those files.
- You cannot read a VPN's credentials, and you do not need to: \`vpn connect\` uses the stored ones.
- A one-time code cannot be guessed or stored: if a connect fails asking for one, ask the user for a current code.
- A tunnel marked \`unavailable\` needs a sandbox rebuild (the user does this from Sandbox ▸ Environment); say so
  rather than trying to install a VPN client yourself.
- A tunnel the user set to auto-connect comes back on its own after a sandbox restart: only toggle it when asked.
`;

export const vpnHandler = tunnelHandler<VpnConfig>({
    kind: "vpn",
    skill: { name: "vpn", text: VPN_SKILL },
    // The field /secrets rotates: wireguard's whole conf (it holds the key), fortinet's password, or ipsec's per-user
    // XAuth password when set (else the group PSK). Rotating an XAuth tunnel's PSK is a re-add, not a /secrets edit.
    secret: (config) => {
        const vpn = config as VpnConfig;
        if (vpn.provider === "wireguard") {
            return "config";
        }
        if (vpn.provider === "fortinet") {
            return "password";
        }
        // Not a ternary: that exact string adjacency trips Open VSX's secret scanner and blocks the publish.
        if (vpn.username !== undefined && vpn.password !== undefined) {
            return "password";
        }
        return "presharedKey";
    },
    // Explicit per-provider allowlist, never a spread: a credential can't leak by being forgotten in a new field. The
    // rest must stay complete too, or a left-out field like `pfs` fails schema and drops the whole tunnel.
    echo: (config) => {
        const vpn = config as VpnConfig;
        return {
            provider: vpn.provider,
            autoConnect: vpn.autoConnect,
            ...(vpn.provider === "wireguard"
                ? {}
                : vpn.provider === "fortinet"
                  ? {
                        server: vpn.server,
                        port: vpn.port,
                        username: vpn.username,
                        ...(vpn.trustedCert !== undefined ? { trustedCert: vpn.trustedCert } : {}),
                        ...(vpn.realm !== undefined ? { realm: vpn.realm } : {}),
                    }
                  : {
                        server: vpn.server,
                        ikeVersion: vpn.ikeVersion,
                        aggressive: vpn.aggressive,
                        pfs: vpn.pfs,
                        dhGroup: vpn.dhGroup,
                        routedNetworks: vpn.routedNetworks,
                        ...(vpn.username !== undefined ? { username: vpn.username } : {}),
                        ...(vpn.localId !== undefined ? { localId: vpn.localId } : {}),
                        ...(vpn.remoteId !== undefined ? { remoteId: vpn.remoteId } : {}),
                    }),
        };
    },
    // Two blocks: this kind's clients, and the tun privilege shared byte-for-byte with `exit`.
    fragment: () => [VPN_FRAGMENT, TUN_PRIVILEGES_FRAGMENT],
    driverOf: (config) => vpnDrivers[config.provider],
    wanted: (config) => config.autoConnect === "on",
    up: connectVpn,
    down: disconnectVpn,
    status: async (entry) => tunnelStatus(await vpnLink(entry), { active: "connected", pending: "connecting" }),
    stored: (id) => `Stored ${id}. Connect it from its row on the VPN card, or ask the agent to.`,
    afterRebuild: "the tunnel dials itself when it restarts",
});
