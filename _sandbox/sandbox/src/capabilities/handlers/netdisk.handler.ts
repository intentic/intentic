import type { NetdiskConfig } from "@intentic/sandbox-contract";
import { netdiskDrivers } from "../../netdisk/netdisk-drivers.js";
import { mountNetdisk, netdiskLink, unmountNetdisk } from "../../netdisk/netdisk-links.js";
import { MOUNT_ROOT } from "../../netdisk/netdisk-paths.js";
import { tunnelHandler, tunnelStatus } from "../../tunnel/tunnel-handler.js";

// Stores a network disk (server, share, credential, access, mount on boot); mounting lives in netdisk/ behind a
// per-protocol driver. The client arrives via this capability's fragment, applied by an owner rebuild; until then a
// link reads unavailable. No runtime directive: every sandbox already runs with CAP_SYS_ADMIN, which is what a mount
// needs, so the rebuild costs one package and no new privilege.

const NETDISK_FRAGMENT = `# netdisk capability: the kernel cifs client's userspace half (mount.cifs). No runtime privilege rides
# with it: the sandbox already holds CAP_SYS_ADMIN for its mount namespaces, and that is all a cifs mount needs.
RUN apt-get update && apt-get install -y --no-install-recommends cifs-utils \\
    && rm -rf /var/lib/apt/lists/*`;

// Agent drives disks through the `netdisk` CLI, never mount.cifs directly, so agent and UI state can't drift apart.
const NETDISK_SKILL = `---
name: netdisk
description: Find, mount and unmount this sandbox's network disks (SMB shares on a NAS or file server). Use when the user asks about files on a share, a NAS, a network drive or a file server, or when a task needs to read or write there.
---

# Network disks

This sandbox's network disks are configured by the user (SMB shares). Each mounts at \`${MOUNT_ROOT}/<name>\`. Use the
\`netdisk\` command: it goes through the daemon, so what you do here is what the user sees in the UI, and vice versa.

\`\`\`sh
netdisk list              # every configured disk, its state, what it mounts, where, and whether it is writable
netdisk status <name>     # one disk, same detail
netdisk mount <name>      # mount it (prints progress; fails loudly with the reason)
netdisk unmount <name>    # let it go
\`\`\`

While a disk is mounted, its files are ordinary files under \`${MOUNT_ROOT}/<name>\`: read them, search them with
\`rg\`, copy them into the workspace. Nothing under \`${MOUNT_ROOT}\` is part of the workspace, so nothing there lands
or commits.

Notes:
- **Read-only is the user's decision, not a fault.** A disk whose \`netdisk list\` line says \`read-only\` refuses
  writes by design: the user chose that on the entry. Copy what you need into the workspace instead, and never
  remount, bind-mount or otherwise work around it; the daemon patrols the mount flags and reports a disk that
  stopped matching its entry.
- A mount that fails with "no route", "did not answer" or "not reachable" usually means the server is behind a VPN
  that is down: \`vpn list\` shows what is up, and \`vpn connect <name>\` brings it back.
- A command that hangs on a mounted disk means the server went away (a dropped tunnel): \`netdisk unmount <name>\`
  frees it; reconnect the VPN, then mount again.
- You cannot read a disk's credentials, and you do not need to: \`netdisk mount\` uses the stored ones.
- A disk marked \`unavailable\` needs a sandbox rebuild (the user does this from Sandbox ▸ Environment); say so rather
  than trying to install cifs-utils yourself.
- A disk the user set to mount on start comes back on its own after a sandbox restart: only unmount it when asked.
`;

export const netdiskHandler = tunnelHandler<NetdiskConfig>({
    kind: "netdisk",
    skill: { name: "netdisk", text: NETDISK_SKILL },
    // A guest share stores no credential at all; everything else rotates its password through /secrets.
    secret: (config) => ((config as NetdiskConfig).password === undefined ? undefined : "password"),
    // Explicit allowlist, never a spread: the password can't leak by being forgotten in a new field.
    echo: (config) => {
        const disk = config as NetdiskConfig;
        return {
            provider: disk.provider,
            server: disk.server,
            share: disk.share,
            username: disk.username,
            access: disk.access,
            version: disk.version,
            autoMount: disk.autoMount,
            hasPassword: disk.password !== undefined,
            ...(disk.path === undefined ? {} : { path: disk.path }),
            ...(disk.domain === undefined ? {} : { domain: disk.domain }),
        };
    },
    fragment: () => [NETDISK_FRAGMENT],
    driverOf: (config) => netdiskDrivers[config.provider],
    wanted: (config) => config.autoMount === "on",
    up: mountNetdisk,
    down: unmountNetdisk,
    status: async (entry) => {
        const link = await netdiskLink(entry);
        // A live mount that disagrees with its entry outranks raw state: it is the one thing the access switch promised.
        if (link.state === "mounted" && link.writable === true && link.access === "read") {
            return { state: "error", detail: "mounted read-write, but the entry says read-only: unmount and mount again" };
        }
        return tunnelStatus(link, { active: "mounted", pending: "mounting" });
    },
    stored: (id) => `Stored ${id}. Mount it from its row on the Network disk entry, or ask the agent to.`,
    afterRebuild: "the disk mounts itself when it restarts",
});
