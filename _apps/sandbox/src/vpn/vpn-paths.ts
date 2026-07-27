import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Where a VPN capability's on-disk state lives, and how a capability id becomes a network interface name.
// One directory for every provider (0700, root-only) so "what has this sandbox been told to dial" is one `ls`.
// Computed from homedir() at call time (not cached) so a test can point HOME at a temp dir, like the ssh handler.

export const vpnDir = (): string => join(homedir(), ".intentic-vpn");

// Linux caps an interface name at IFNAMSIZ-1 = 15 bytes. An id short enough to be legal IS the interface name —
// the readable, overwhelmingly common case — and a longer one falls back to a deterministic hash so two long
// ids that share a prefix can never collide on one interface.
export const INTERFACE_MAX = 15;
export const interfaceName = (id: string): string =>
    id.length <= INTERFACE_MAX
        ? id
        : `vpn-${createHash("sha256")
              .update(id)
              .digest("hex")
              .slice(0, INTERFACE_MAX - 4)}`;

// wg-quick derives the interface from the config's FILE NAME, so the wireguard conf is named for the interface
// rather than the id — they differ only for an id too long to be an interface name.
export const wireguardConfPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.conf`);
// openconnect writes its own pid here once it forks into the background; its presence + a live process is what
// "connected" means for a fortinet tunnel.
export const pidPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.pid`);
// The client's own output for one dial, kept so a failed connect has a diagnosable tail and a backgrounded
// client has somewhere to write. Truncated per dial — this is a post-mortem, not a log history.
export const logPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.log`);
// Touched when a dial succeeds, removed on disconnect: its mtime is the tunnel's "up since". ADVISORY ONLY —
// liveness is always read from the OS, so a missing marker costs an uptime label, never a wrong state.
export const upMarkerPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.up`);

// strongSwan is a system daemon with system-wide config, so its per-connection files live under /etc rather
// than the home dir: /etc/ipsec.conf and /etc/ipsec.secrets each `include` this directory, which lets one
// connection be written, reread and torn down without regenerating the others.
export const IPSEC_INCLUDE_DIR = "/etc/ipsec.d/intentic";
export const ipsecConnPath = (id: string): string => join(IPSEC_INCLUDE_DIR, `${connName(id)}.conf`);
export const ipsecSecretsPath = (id: string): string => join(IPSEC_INCLUDE_DIR, `${connName(id)}.secrets`);
// strongSwan connection names are whitespace-delimited tokens in ipsec.conf; capability ids are already
// restricted to [A-Za-z0-9_-] by the contract's entryId, so the id passes through unchanged.
export const connName = (id: string): string => id;
