import { homedir } from "node:os";
import { join } from "node:path";
import { interfaceNameOf } from "../tunnel/tunnel-paths.js";

// On-disk state for VPN capabilities, and how a capability id becomes an interface name. One directory for every
// provider (0700, root-only). Computed from homedir() at call time, not cached, so a test can point HOME at a temp dir.

export const vpnDir = (): string => join(homedir(), ".intentic-vpn");

// The bare id is the interface name where it fits (tunnel/tunnel-paths.ts has the rule and the hash fallback).
export const interfaceName = (id: string): string => interfaceNameOf(id, "vpn");

// wg-quick derives the interface from the config's file name, so this is named for the interface, not the id.
export const wireguardConfPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.conf`);
// openconnect's own pid once backgrounded; presence plus a live process means connected for fortinet.
export const pidPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.pid`);
// The client's output for one dial, truncated per dial; a post-mortem, not a log history.
export const logPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.log`);
// Touched on dial success, removed on disconnect; a missing marker costs the uptime label, not the state.
export const upMarkerPath = (id: string): string => join(vpnDir(), `${interfaceName(id)}.up`);

// strongSwan is a system daemon with system-wide config, so per-connection files live under /etc, included by
// /etc/ipsec.conf and /etc/ipsec.secrets so one connection can be rewritten without regenerating the others.
export const IPSEC_INCLUDE_DIR = "/etc/ipsec.d/intentic";
export const ipsecConnPath = (id: string): string => join(IPSEC_INCLUDE_DIR, `${connName(id)}.conf`);
export const ipsecSecretsPath = (id: string): string => join(IPSEC_INCLUDE_DIR, `${connName(id)}.secrets`);
// Connection names are whitespace-delimited tokens; capability ids already qualify, so this is a passthrough.
export const connName = (id: string): string => id;
