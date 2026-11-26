import { freemem, totalmem } from "node:os";
import { HOST_LOW_FLOOR_BYTES, type HostMemory, hostMemoryLowBytes, WSL_ENGINE_DISTRO, WSL_SYSTEM_DISTROS } from "@intentic/sandbox-contract/schemas/hosts";
import { WINDOWS_SIDE } from "./wsl.js";

/* WINDOWS' MEMORY, AND WHEN TO GIVE IT BACK FROM WSL (2026-11-02). The WSL2 VM keeps the file cache it builds (a build,
   a `docker pull`, a sandbox's checkout) as memory taken from Windows, and `.wslconfig`'s autoMemoryReclaim hands it back
   only once WSL has gone idle, which a PC running a sandbox never is. On 2026-11-02 rog's Windows was down to 1.1 GB
   available while the VM held 20 GB, about 10 GB of it cache, and Windows paged itself into a 43 s freeze. Dropping the
   VM's clean cache costs only re-reading files later, and the pages it frees go straight back to Windows. Pure decisions
   here; the resident agent runs them on its tick (wsl-cache-drop.ts).

   Two lines since 2026-11-22. marta (31 GiB) sat at 4-5 GiB available for hours while the VM held 5 GiB of cache from a
   sandbox OCR-ing its owner's documents, above the low line, so nothing was given back until Windows was nearly out; the
   drops that did run freed 0-0.7 GiB each. So a drop is also due under a fifth of the machine, at a slower pace than
   under the low line, where it stays urgent. */

// What Windows has now, or undefined anywhere but its Windows side (schemas/hosts.ts says why only there). On Windows,
// `os.freemem()` is libuv's uv_get_free_memory, which is GlobalMemoryStatusEx's ullAvailPhys: available physical memory,
// standby cache included, the same number Task Manager calls Available. Cheap enough for every heartbeat.
export const windowsMemory = (): HostMemory | undefined => (WINDOWS_SIDE ? { availableBytes: freemem(), totalBytes: totalmem() } : undefined);

// At most one drop this often under the low line: a drop that freed little (Windows' own programs are what fill it) is
// not repeated every tick, and a cache rebuilt within minutes is the VM's working set, not leftovers.
export const DROP_COOLDOWN_MS = 5 * 60_000;

// Under a fifth of the machine but above the low line, Windows is tight rather than short: the cache is given back early,
// before Windows starts paging, but only this often, since a Windows filled by its own programs keeps it there and every
// drop costs a sandbox re-reading its files.
const EARLY_DROP_SHARE = 0.2;
export const EARLY_DROP_COOLDOWN_MS = 30 * 60_000;

/* A DROP THAT GAVE WINDOWS NOTHING IS NOT REPEATED EVERY FIVE MINUTES (2026-11-24). rog's Windows sits at 2-3 GiB of
   31.4 available whatever the VM's cache holds: .wslconfig gives the VM 22 GB and the VM keeps it, so Windows stays under
   its 3.1 GiB low line for good. The agent dropped 287 times in 39 hours, 5.07 minutes apart, for a median 0.2 GiB back
   each, while every drop threw away up to 8.5 GB of every sandbox's cache, which they then read back from disk at
   100-260 MB/s. So after a drop that gave back less than WORTHWHILE_DROP_BYTES the next one under the low line waits
   twice as long, up to MAX_DROP_COOLDOWN_MS; one that gave back that much, or Windows climbing out of tight altogether,
   brings the five minutes back. Under the 1.5 GiB floor, where rog froze, the five minutes hold however little the last
   drop gave: there a quarter of a gigabyte can be the difference.

   SANDBOXES RECLAIM FROM THEIR OWN CGROUPS FIRST (2026-11-26). Each sandbox sees the same host-low reading and
   reclaims cold cache from its own cgroup via `memory.reclaim`, sized and paced to avoid stalling active turns
   (hosts/reclaim/host-reclaim.ts in @intentic/sandbox). The blanket drop becomes a fallback: above the floor it
   waits for the sandboxes' own reclaim instead (they have RECLAIM_GRACE_MS to act), and under the floor it runs as
   before since the floor is where Windows froze. Measured on rog the same day, a sandbox's own 1 GiB reclaim freed
   that much inside the VM but in blocks too small for free page reporting, and Windows' Available memory did not move
   beyond its noise in the 30 s after: the drop, which compacts, is still what hands memory back. The grace costs at
   most RECLAIM_GRACE_MS once per low spell, since the spell (lowSpellSince) lasts until Windows is over a fifth of its
   memory again. */
export const WORTHWHILE_DROP_BYTES = 0.5 * 1024 ** 3;
export const MAX_DROP_COOLDOWN_MS = 60 * 60_000;

// How long to wait for sandboxes' own cgroup reclaim before the blanket drop runs. Two heartbeats give each sandbox
// at least one chance to see the host-low reading and reclaim from its own cgroup.
export const RECLAIM_GRACE_MS = 60_000;

// The cooldown under the low line after a drop gave back `freedBytes` (undefined: the drop failed, or Windows could not
// be read after it, which says nothing about whether drops help).
export const nextDropCooldown = (cooldownMs: number, freedBytes: number | undefined): number => {
    if (freedBytes === undefined) {
        return cooldownMs;
    }
    return freedBytes >= WORTHWHILE_DROP_BYTES ? DROP_COOLDOWN_MS : Math.min(MAX_DROP_COOLDOWN_MS, cooldownMs * 2);
};

// Windows out of tight altogether: whatever drops did before, the next time it runs low starts at five minutes again.
export const recoveredFromTight = (memory: HostMemory): boolean => memory.availableBytes >= EARLY_DROP_SHARE * memory.totalBytes;

// When the low spell `memory` belongs to began, for shouldDropCache's `lowSince`: kept while Windows stays tight, begun
// `now` when it first goes under the host line, ended once it has recovered over a fifth of its memory.
export const lowSpellSince = (memory: HostMemory, lowSince: number | undefined, now: number): number | undefined => {
    if (recoveredFromTight(memory)) {
        return undefined;
    }
    return lowSince ?? (memory.availableBytes < hostMemoryLowBytes(memory.totalBytes) ? now : undefined);
};

// Whether to drop the VM's cache now: Windows is under the 1.5 GiB floor and the last drop is DROP_COOLDOWN_MS old, under
// the host line both sides keep (hostMemoryLowBytes) and the last drop is `cooldownMs` old (nextDropCooldown), or under a
// fifth of the machine and the last drop is EARLY_DROP_COOLDOWN_MS old, or `cooldownMs` if longer. Never asked whether
// WSL runs: that is a spawn, paid only once this says yes.
//
// (2026-11-26) Above the 1.5 GiB floor, the drop waits for RECLAIM_GRACE_MS after the host first went low
// (`lowSince`), so sandboxes' own cgroup reclaim has a chance to bring it back without throwing away every sandbox's
// cache. Under the floor the drop runs at once as before: that is where Windows froze.
export const shouldDropCache = (
    memory: HostMemory,
    lastDropAt: number,
    now: number,
    cooldownMs: number = DROP_COOLDOWN_MS,
    lowSince: number | undefined = undefined,
): boolean => {
    const since = now - lastDropAt;
    if (memory.availableBytes < HOST_LOW_FLOOR_BYTES) {
        return since >= DROP_COOLDOWN_MS;
    }
    // Above the floor: give sandboxes time to reclaim from their own cgroups first.
    if (lowSince !== undefined && now - lowSince < RECLAIM_GRACE_MS) {
        return false;
    }
    if (memory.availableBytes < hostMemoryLowBytes(memory.totalBytes)) {
        return since >= cooldownMs;
    }
    return memory.availableBytes < EARLY_DROP_SHARE * memory.totalBytes && since >= Math.max(EARLY_DROP_COOLDOWN_MS, cooldownMs);
};

// A WSL registration name: letters, digits, dots, dashes and underscores, never a space. Whatever else a listing prints
// (`There are no running distributions.`, a localized error) is not a distro.
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/;

// `wsl.exe --list --running --quiet` as bytes. wsl.exe writes UTF-16LE unless WSL_UTF8=1 is honoured, which older builds
// ignore, so the bytes say which: ASCII names in UTF-16LE have a NUL in every second byte. A BOM is dropped either way.
export const decodeWslListing = (bytes: Buffer): string => {
    const utf16 = bytes.length >= 2 && (bytes[1] === 0 || (bytes[0] === 0xff && bytes[1] === 0xfe));
    return (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/^﻿/, "");
};

// Every running distro the listing names, Docker Desktop's own included: one kernel serves them all, so any of them can
// drop its cache.
export const runningDistrosFrom = (listing: string): string[] =>
    listing
        .replaceAll("\0", "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => DISTRO_NAME.test(line));

// Which running distro to drop the cache through: the user's own first, since an engine's distro is its engine's (a
// minimal image whose shell and root login are its own business), then whichever engine distro is up: docker-desktop,
// or Intentic's own. Undefined when nothing runs: WSL is never booted for this, a VM that is not running holds no cache.
export const cacheDropDistro = (running: readonly string[]): string | undefined =>
    running.find((distro) => !WSL_SYSTEM_DISTROS.has(distro)) ??
    running.find((distro) => distro === "docker-desktop" || distro === WSL_ENGINE_DISTRO);

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// The one line a drop leaves in the agent's log: how much Windows had before, and a few seconds after, and the longer
// wait the next drop now has when this one gave back little (nextDropCooldown).
export const dropLine = (distro: string, before: HostMemory, after: HostMemory, afterMs: number, backedOffMs?: number): string =>
    `Windows was low on memory (${gib(before.availableBytes)} of ${gib(before.totalBytes)} available): dropped the WSL VM's file cache through ${distro}; ${gib(after.availableBytes)} available ${Math.round(afterMs / 1000)}s later.${
        backedOffMs === undefined ? "" : ` It gave back little, so the next drop waits ${Math.round(backedOffMs / 60_000)} min unless Windows falls under ${gib(HOST_LOW_FLOOR_BYTES)}.`
    }`;
