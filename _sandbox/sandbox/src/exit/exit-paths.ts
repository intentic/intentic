import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { interfaceNameOf } from "../tunnel/tunnel-paths.js";

// Where a geo exit's on-disk state lives, its tunnel interface name, and its SOCKS proxy port. One directory per
// sandbox (0700, root-only). Computed from homedir() at call time, not cached, so tests can point HOME at a temp dir.

export const exitDir = (): string => join(homedir(), ".intentic-exit");

// Per-exit scratch (torrc, tor's DataDirectory, a decoded .ovpn, a generated wg conf); its own subdirectory per id,
// since tor requires an unshared 0700 DataDirectory and erasing one exit must not touch another's files.
export const exitStateDir = (id: string): string => join(exitDir(), id);

// Must not collide with a vpn's interface (same netns), hence the `x` prefix over the vpn kind's bare id; IFNAMSIZ and
// the hash fallback live in tunnel/tunnel-paths.ts.
export const exitInterface = (id: string): string => interfaceNameOf(`x${id}`, "x");

// Derived, not allocated: callers keep pointing at one port while the exit moves country. A stable hash into a private
// range; a collision is refused at start, not silently drifted.
const PORT_BASE = 19_000;
const PORT_SPAN = 1_000;
export const exitProxyPort = (id: string): number =>
    PORT_BASE + (Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % PORT_SPAN);

// One span above the SOCKS port, derivable from the id; a second tor can't attach to another's control socket.
export const exitControlPort = (id: string): number => exitProxyPort(id) + PORT_SPAN;

// Never table 254 (main): a route written there would swallow the sandbox's own uplink. Offset from the port so it's
// derivable and per-exit, clear of the reserved 253-255.
export const exitRouteTable = (id: string): number => 100 + (exitProxyPort(id) - PORT_BASE);

export const torrcPath = (id: string): string => join(exitStateDir(id), "torrc");
export const torDataDir = (id: string): string => join(exitStateDir(id), "data");
export const torCookiePath = (id: string): string => join(exitStateDir(id), "control.cookie");
export const ovpnPath = (id: string): string => join(exitStateDir(id), "exit.ovpn");
export const wgConfPath = (id: string): string => join(exitStateDir(id), `${exitInterface(id)}.conf`);
export const pidPath = (id: string): string => join(exitStateDir(id), "client.pid");
// Client's own output for one start, truncated per attempt; a post-mortem for a failed dial, not a history.
export const logPath = (id: string): string => join(exitStateDir(id), "client.log");
// Touched when up, removed when down; mtime is "up since"; liveness is read off the machine, not this file.
export const upMarkerPath = (id: string): string => join(exitStateDir(id), "up");
// Last thing asked of a live exit: which country and catalog entry. Not the truth of where traffic comes out (that's
// the observation); lets rotate avoid repicking and a restarted daemon report what a client was aimed at.
export const selectionPath = (id: string): string => join(exitStateDir(id), "selection.json");
// Last ExitObservation, so `list` can render a cached address/time without re-probing every exit on every poll.
export const observationPath = (id: string): string => join(exitStateDir(id), "observation.json");
// A provider catalog cached off the network; refreshed on a miss or when stale, else the baked fallback answers.
export const catalogPath = (provider: string): string => join(exitDir(), `catalog-${provider}.json`);
