import { freemem, totalmem } from "node:os";
import { type HostMemory, hostMemoryLowBytes, WSL_ENGINE_DISTRO, WSL_SYSTEM_DISTROS } from "@intentic/sandbox-contract/schemas/hosts";
import { WINDOWS_SIDE } from "./wsl.js";

/* WINDOWS' MEMORY, AND WHEN TO GIVE IT BACK FROM WSL (2026-11-02). The WSL2 VM keeps the file cache it builds (a build,
   a `docker pull`, a sandbox's checkout) as memory taken from Windows, and `.wslconfig`'s autoMemoryReclaim hands it back
   only once WSL has gone idle, which a PC running a sandbox never is. On 2026-11-02 rog's Windows was down to 1.1 GB
   available while the VM held 20 GB, about 10 GB of it cache, and Windows paged itself into a 43 s freeze. Dropping the
   VM's clean cache costs only re-reading files later, and the pages it frees go straight back to Windows. Pure decisions
   here; the resident agent runs them on its tick (wsl-cache-drop.ts). */

// What Windows has now, or undefined anywhere but its Windows side (schemas/hosts.ts says why only there). On Windows,
// `os.freemem()` is libuv's uv_get_free_memory, which is GlobalMemoryStatusEx's ullAvailPhys: available physical memory,
// standby cache included, the same number Task Manager calls Available. Cheap enough for every heartbeat.
export const windowsMemory = (): HostMemory | undefined => (WINDOWS_SIDE ? { availableBytes: freemem(), totalBytes: totalmem() } : undefined);

// At most one drop this often: a drop that freed little (Windows' own programs are what fill it) is not repeated every
// tick, and a cache rebuilt within minutes is the VM's working set, not leftovers.
export const DROP_COOLDOWN_MS = 5 * 60_000;

// Whether to drop the VM's cache now: Windows is under the host line both sides keep (hostMemoryLowBytes) and the last
// drop is DROP_COOLDOWN_MS old. Never asked whether WSL runs: that is a spawn, paid only once this says yes.
export const shouldDropCache = (memory: HostMemory, lastDropAt: number, now: number): boolean =>
    memory.availableBytes < hostMemoryLowBytes(memory.totalBytes) && now - lastDropAt >= DROP_COOLDOWN_MS;

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

// The one line a drop leaves in the agent's log: how much Windows had before, and a few seconds after.
export const dropLine = (distro: string, before: HostMemory, after: HostMemory, afterMs: number): string =>
    `Windows was low on memory (${gib(before.availableBytes)} of ${gib(before.totalBytes)} available): dropped the WSL VM's file cache through ${distro}; ${gib(after.availableBytes)} available ${Math.round(afterMs / 1000)}s later.`;
