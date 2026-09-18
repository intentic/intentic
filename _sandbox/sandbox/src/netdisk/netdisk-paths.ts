import { homedir } from "node:os";
import { join } from "node:path";

// On-disk state for network-disk capabilities, and where each one mounts. One directory for every provider (0700,
// root-only). Computed from homedir() at call time, not cached, so a test can point HOME at a temp dir.

export const netdiskDir = (): string => join(homedir(), ".intentic-netdisk");

// mount.cifs reads the credential from a file (never argv, so it stays out of `ps`); 0600, one per disk.
export const credentialsPath = (id: string): string => join(netdiskDir(), `${id}.cred`);
// Touched on mount success, removed on unmount; a missing marker costs the uptime label, not the state.
export const upMarkerPath = (id: string): string => join(netdiskDir(), `${id}.up`);

// Every disk mounts under one root, so the agent's skill can say where files are without reading the manifest, and the
// invariant can ask what is mounted there that the manifest never asked for.
export const MOUNT_ROOT = "/mnt/netdisk";
// Capability ids are `[a-zA-Z0-9][a-zA-Z0-9_-]*`, so the id is a legal path segment as is.
export const mountPoint = (id: string): string => join(MOUNT_ROOT, id);
