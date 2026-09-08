import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentDrift, RuntimeInstall } from "@intentic/sandbox-contract";

const execFileAsync = promisify(execFile);

// What the live container has that the image did not, observed rather than parsed from a command: the ledger says why
// something was installed, this module says whether it is actually there, and the auto-drafter only acts when both
// agree.
// - apt: read from dpkg.log's exact package names and timestamps, since dpkg's own archive mtimes are useless for a
//   time comparison.
// - everything else: an mtime sweep over known install prefixes against a sentinel stamped with the container's birth
//   (PID 1's start time, from /proc/1/stat).

// USER_HZ for /proc's starttime; always 100 on this image's Linux, cheaper than spawning getconf for it.
const CLOCK_TICKS_PER_SECOND = 100;

export const containerBornAtMs = async (): Promise<number> => {
    const statLine = await readFile("/proc/1/stat", "utf8");
    // comm field is parenthesised and may contain spaces; everything after the last ')' is fixed-format.
    const fields = statLine
        .slice(statLine.lastIndexOf(")") + 2)
        .trim()
        .split(" ");
    // Field 22 of the full line; fields[0] here is field 3 (state), so starttime sits at index 19.
    const startTicks = Number(fields[19]);
    const uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) {
        throw new Error("unreadable /proc/1/stat or /proc/uptime");
    }
    return Date.now() - Math.round((uptimeSeconds - startTicks / CLOCK_TICKS_PER_SECOND) * 1000);
};

// Matches dpkg install/remove/purge lines; a later remove or purge cancels an earlier install entry.
const DPKG_ACTION = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (install|remove|purge) (\S+?)(?::\S+)? /;

export const dpkgInstallsSince = (log: string, sinceMs: number): string[] => {
    const packages = new Set<string>();
    for (const line of log.split("\n")) {
        const match = DPKG_ACTION.exec(line);
        if (match === null) {
            continue;
        }
        const [, at, action, name] = match;
        if (action === "install" && Date.parse(at!.replace(" ", "T")) > sinceMs) {
            packages.add(name!);
        } else if (action !== "install") {
            packages.delete(name!);
        }
    }
    return [...packages];
};

// Hand-install landing spots only; cargo/rustup appear twice for two different install routes.
const DRIFT_ROOTS = [
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/local/lib",
    "/usr/local/share",
    "/usr/local/include",
    "/usr/local/etc",
    "/usr/local/cargo/bin",
    "/usr/local/rustup/toolchains",
    "/root/.cargo/bin",
    "/root/.rustup/toolchains",
    "/root/.local/bin",
    "/root/.local/lib",
    "/root/.local/share",
    "/root/go/bin",
    "/root/.cache/ms-playwright",
    "/opt",
];

// Daemon's own runtime writes; excluded so its own bookkeeping never reports as session-caused drift.
const DRIFT_IGNORES = ["/.local/share/intentic/", "/.local/share/pki/", "/ms-playwright/b/"];

// Entries kept after collapsing; the card shows drift as a paragraph, not a full file inventory.
const MAX_PATHS = 40;
// A dir this deep with this many new files collapses to one entry; depth 4 keeps /usr/local/bin itemized.
const COLLAPSE_DEPTH = 4;
const COLLAPSE_AT = 4;

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

export const collapseDriftPaths = (paths: readonly string[], limit = MAX_PATHS): string[] => {
    const counts = new Map<string, number>();
    for (const path of paths) {
        const segments = segmentsOf(path);
        for (let depth = COLLAPSE_DEPTH; depth < segments.length; depth += 1) {
            const dir = `/${segments.slice(0, depth).join("/")}`;
            counts.set(dir, (counts.get(dir) ?? 0) + 1);
        }
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of [...paths].toSorted()) {
        const segments = segmentsOf(path);
        let entry = path;
        // The shallowest qualifying ancestor, so one download is one entry rather than one per subdirectory.
        for (let depth = COLLAPSE_DEPTH; depth < segments.length; depth += 1) {
            const dir = `/${segments.slice(0, depth).join("/")}`;
            const count = counts.get(dir) ?? 0;
            if (count >= COLLAPSE_AT) {
                entry = `${dir}/ (${count} files)`;
                break;
            }
        }
        if (!seen.has(entry)) {
            seen.add(entry);
            out.push(entry);
        }
    }
    return out.length > limit ? [...out.slice(0, limit), `… and ${out.length - limit} more`] : out;
};

// Sentinel `find -newer` compares against, stamped with the container's birth; lives under tmpdir, dies with the
// container.
const sentinelPath = (): string => join(tmpdir(), ".intentic-drift-born");

const pathDrift = async (bornAtMs: number): Promise<string[]> => {
    const sentinel = sentinelPath();
    await writeFile(sentinel, "");
    await utimes(sentinel, bornAtMs / 1000, bornAtMs / 1000);
    const roots = DRIFT_ROOTS.filter((root) => existsSync(root));
    if (roots.length === 0) {
        return [];
    }
    // Through sh so one bad path doesn't blank the output; roots are fixed constants, not user input.
    const command = `find ${roots.join(" ")} -xdev -newer ${sentinel} -not -type d -print 2>/dev/null || true`;
    const { stdout } = await execFileAsync("sh", ["-c", command], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const paths = stdout.split("\n").filter((line) => line !== "" && !DRIFT_IGNORES.some((ignore) => line.includes(ignore)));
    return collapseDriftPaths(paths);
};

// Cached briefly so the click-triggered refresh and the timed sweep don't repeat the same find walk.
const CACHE_TTL_MS = 5 * 60_000;
let cached: { drift: EnvironmentDrift; at: number } | undefined;

export const clearDriftCache = (): void => {
    cached = undefined;
};

export const computeDrift = async (): Promise<EnvironmentDrift> => {
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.drift;
    }
    const bornAt = await containerBornAtMs();
    const log = await readFile("/var/log/dpkg.log", "utf8").catch(() => "");
    const drift: EnvironmentDrift = {
        bornAt,
        at: Date.now(),
        apt: dpkgInstallsSince(log, bornAt),
        paths: await pathDrift(bornAt),
    };
    cached = { drift, at: Date.now() };
    return drift;
};

// Whether a ledger entry is actually present in the container, the gate against a one-off experiment, a failed install,
// or a stale line. Checked kind by kind: a targeted stat is cheaper and sharper than searching the collapsed display
// paths.

const newerThan = async (path: string, bornAtMs: number): Promise<boolean> => {
    const info = await stat(path).catch(() => undefined);
    return info !== undefined && info.mtimeMs > bornAtMs;
};

const CARGO_BINS = ["/usr/local/cargo/bin", "/root/.cargo/bin"];
const RUSTUP_TOOLCHAINS = ["/usr/local/rustup/toolchains", "/root/.rustup/toolchains"];
const NPM_GLOBALS = ["/usr/local/lib/node_modules"];
const PLAYWRIGHT_CACHE = "/root/.cache/ms-playwright";

const anyNewer = async (paths: readonly string[], bornAtMs: number): Promise<boolean> => {
    const checks = await Promise.all(paths.map((path) => newerThan(path, bornAtMs)));
    return checks.some(Boolean);
};

export const installLive = async (entry: Pick<RuntimeInstall, "tool" | "kind">, drift: EnvironmentDrift): Promise<boolean> => {
    const { tool, kind } = entry;
    switch (kind) {
        case "apt":
            return drift.apt.includes(tool);
        case "cargo":
            return anyNewer(
                CARGO_BINS.map((dir) => join(dir, tool)),
                drift.bornAt,
            );
        case "rustup-target": {
            for (const root of RUSTUP_TOOLCHAINS.filter((dir) => existsSync(dir))) {
                const toolchains = await readdir(root).catch(() => []);
                if (
                    await anyNewer(
                        toolchains.map((toolchain) => join(root, toolchain, "lib", "rustlib", tool)),
                        drift.bornAt,
                    )
                ) {
                    return true;
                }
            }
            return false;
        }
        case "npm":
            return anyNewer(
                NPM_GLOBALS.map((dir) => join(dir, tool)),
                drift.bornAt,
            );
        case "playwright": {
            const entries = await readdir(PLAYWRIGHT_CACHE).catch(() => []);
            return anyNewer(
                entries.filter((name) => name.startsWith(tool)).map((name) => join(PLAYWRIGHT_CACHE, name)),
                drift.bornAt,
            );
        }
        default: {
            // No known landing spot: falls back to the display sweep, normalised for pip's `-` vs site-packages' `_`.
            const needle = tool.toLowerCase().replaceAll("_", "-");
            return drift.paths.some((path) => path.toLowerCase().replaceAll("_", "-").includes(needle));
        }
    }
};
