import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Where a geo exit's on-disk state lives, what its tunnel interface is called, and which local port its SOCKS
// proxy answers on. One directory per sandbox (0700, root-only) so "what has this sandbox been told to come
// out of" is one `ls`. Computed from homedir() at call time (not cached) so a test can point HOME at a temp
// dir, the vpn subsystem's precedent.

export const exitDir = (): string => join(homedir(), ".intentic-exit");

// Per-exit scratch: torrc + tor's DataDirectory, a decoded .ovpn, a generated wg conf. Its own subdirectory
// per id because tor insists its DataDirectory be 0700 and not shared, and because erasing one exit must not
// reach into another's files.
export const exitStateDir = (id: string): string => join(exitDir(), id);

// Linux caps an interface name at IFNAMSIZ-1 = 15 bytes, and an exit's interface must not collide with a vpn's
// (both live in the same netns), hence the `x` prefix rather than the vpn subsystem's bare id. A short id keeps
// a readable name; a long one falls back to a deterministic hash so two long ids sharing a prefix cannot land
// on one interface.
const INTERFACE_MAX = 15;
export const exitInterface = (id: string): string => {
    const candidate = `x${id}`;
    return candidate.length <= INTERFACE_MAX
        ? candidate
        : `x-${createHash("sha256")
              .update(id)
              .digest("hex")
              .slice(0, INTERFACE_MAX - 2)}`;
};

/* THE PROXY PORT IS DERIVED, NOT ALLOCATED, and that is the whole contract this feature rests on: callers
 * point at a port and keep pointing at it while the exit moves between countries under them. A port handed out
 * at start time would move on every restart, and every browser profile and every shell that had been told
 * about it would be pointing at nothing.
 *
 * So: a stable hash of the id into a private range. Two exits colliding is a 1-in-1000 birthday draw over a
 * handful of entries, and it is DETECTED rather than worked around, the start refuses with "rename one of
 * them", because silently drifting to another port would break the one promise above. */
const PORT_BASE = 19_000;
const PORT_SPAN = 1_000;
export const exitProxyPort = (id: string): number =>
    PORT_BASE + (Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % PORT_SPAN);

// Tor's control port sits one span above its SOCKS port, so the pair is derivable from the id alone and a
// second tor cannot silently attach to the first one's control socket.
export const exitControlPort = (id: string): number => exitProxyPort(id) + PORT_SPAN;

// The routing table an exit's default route lives in. Never table 254 (main): an exit that wrote there would
// swallow the sandbox's own uplink, which is the one failure this whole design exists to prevent. Offset by
// the port so it is derivable and per-exit; well clear of the reserved 253-255.
export const exitRouteTable = (id: string): number => 100 + (exitProxyPort(id) - PORT_BASE);

export const torrcPath = (id: string): string => join(exitStateDir(id), "torrc");
export const torDataDir = (id: string): string => join(exitStateDir(id), "data");
export const torCookiePath = (id: string): string => join(exitStateDir(id), "control.cookie");
export const ovpnPath = (id: string): string => join(exitStateDir(id), "exit.ovpn");
export const wgConfPath = (id: string): string => join(exitStateDir(id), `${exitInterface(id)}.conf`);
export const pidPath = (id: string): string => join(exitStateDir(id), "client.pid");
// The client's own output for one start, truncated per attempt: a post-mortem for a failed dial, not a history.
export const logPath = (id: string): string => join(exitStateDir(id), "client.log");
// Touched when an exit comes up, removed when it goes down; its mtime is the "up since". ADVISORY ONLY, every
// liveness answer is read off the machine, so a missing marker costs a label and never a wrong state.
export const upMarkerPath = (id: string): string => join(exitStateDir(id), "up");
/* The last thing asked of a live exit: which country, and which catalog entry was picked to serve it. Written
 * on every successful use/rotate. NOT the source of truth for where traffic comes out, that is only ever the
 * observation, this is what lets `rotate` know which server to avoid picking again and what lets a restarted
 * daemon report which country a still-running client was aimed at. */
export const selectionPath = (id: string): string => join(exitStateDir(id), "selection.json");
// The last ExitObservation, so a `list` can render "DE · 5.9.x.x, checked 2m ago" without re-probing every
// exit on every poll (a check goes out over the network and the capability card polls).
export const observationPath = (id: string): string => join(exitStateDir(id), "observation.json");
// A provider catalog, cached off the network. Refreshed on a miss or when stale; the baked fallback answers
// when the provider cannot be reached at all.
export const catalogPath = (provider: string): string => join(exitDir(), `catalog-${provider}.json`);
