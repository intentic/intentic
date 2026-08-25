import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentDrift, RuntimeInstall } from "@intentic/sandbox-contract";

const execFileAsync = promisify(execFile);

/* ENVIRONMENT DRIFT: what the live container has that the image did not put there.
 *
 * Everything here is OBSERVATION — the ground truth the runtime-install ledger's command parsing can never be.
 * A `curl | sh` installer, a tool a script pulled in, an install phrased in a way no regex anticipated: all of
 * them leave marks on the filesystem, and the filesystem does not depend on how the command was spelled. The
 * ledger says why something was installed; this module says whether it is actually THERE, and the auto-drafter
 * (auto-drafts.ts) refuses to propose anything the two do not agree on.
 *
 * Two channels, disjoint by construction:
 *
 *   - apt reads /var/log/dpkg.log. dpkg unpacks files with their ARCHIVE mtimes — days or years old — so an
 *     mtime sweep is structurally blind to apt, and dpkg's own log is exact: package names, timestamps, and
 *     nothing to parse out of a command line. Entries logged during the image build predate the container's
 *     birth and filter out on the timestamp alone.
 *
 *   - everything else is an mtime sweep over the prefixes hand-installed software lands in (`find -newer` a
 *     sentinel file stamped with the container's birth). Anything a session installs at runtime — a cargo
 *     binary, a rustup target, a browser download, a curl|sh script's droppings — is newer than the container
 *     by definition, and anything the image baked is older by the same definition.
 *
 * The container's birth is PID 1's start time, computed from /proc/1/stat rather than stat'ed off some file a
 * boot script happens to touch: field 22 is start time in clock ticks since the (host) boot /proc/uptime also
 * counts from, so the two subtract cleanly whether or not this is a container. */

// USER_HZ, the unit of /proc/<pid>/stat's starttime. 100 on every Linux the sandbox image ships on (x86-64 and
// arm64 both); reading it via getconf would spend a process spawn to learn the number 100.
const CLOCK_TICKS_PER_SECOND = 100;

export const containerBornAtMs = async (): Promise<number> => {
    const statLine = await readFile("/proc/1/stat", "utf8");
    // The comm field is parenthesised and may itself contain spaces; everything after the LAST ')' is fixed.
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

/* Debian packages installed since `sinceMs`, from dpkg's log content. The `install` action is a NEW package
 * being unpacked (an upgrade logs `upgrade`, configure passes log `configure`), which is exactly the set that
 * would need a Dockerfile step. A later `remove`/`purge` cancels the entry: a package tried and taken back is
 * not drift, and reporting it would draft a step for something the session decided against. dpkg logs local
 * time with no zone marker; parsed the same way, against the same clock, so the comparison is consistent
 * whatever TZ the container runs. */
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

/* Where hand-installed software lands. Deliberately NOT the whole filesystem: /work is the workspace (persists,
 * not drift), /tmp is scratch by design, /var and /usr/{bin,lib,share} belong to apt (the dpkg channel), and
 * caches churn without meaning. Cargo and rustup appear twice because the overlay's rust block installs to
 * /usr/local/{cargo,rustup} while the stock `curl sh.rustup.rs` route lands in /root — and only their
 * meaningful corners: a `cargo build` churns $CARGO_HOME/registry with no drift to report. */
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

/* The daemon's own runtime writes inside the watched roots, observed on a live sandbox: its state dir, the
 * certificate store its browser sessions maintain, and the browser-session markers playwright files next to
 * its cache. Drift is what SESSIONS installed; the daemon reporting its own bookkeeping would put a permanent
 * false entry on every card. Substrings, applied after the walk, so the find stays one plain command. */
const DRIFT_IGNORES = ["/.local/share/intentic/", "/.local/share/pki/", "/ms-playwright/b/"];

// Entries kept after collapsing; a paragraph, not an inventory — the card shows drift, corroboration reads the
// targeted probes below, and nothing needs the ten-thousandth browser file by name.
const MAX_PATHS = 40;
// A directory this deep that holds this many new files becomes one entry. Depth 4 keeps /usr/local/bin (depth
// 3) itemized — new binaries are the signal, their names ARE the finding — while a browser download or an
// unpacked toolchain collapses to the directory that names it.
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
        // The SHALLOWEST qualifying ancestor, so one download is one entry rather than one per subdirectory.
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

// The sentinel `find -newer` compares against, stamped with the container's birth. Under tmpdir so it dies with
// the container, exactly like the moment it encodes.
const sentinelPath = (): string => join(tmpdir(), ".intentic-drift-born");

const pathDrift = async (bornAtMs: number): Promise<string[]> => {
    const sentinel = sentinelPath();
    await writeFile(sentinel, "");
    await utimes(sentinel, bornAtMs / 1000, bornAtMs / 1000);
    const roots = DRIFT_ROOTS.filter((root) => existsSync(root));
    if (roots.length === 0) {
        return [];
    }
    // Through sh so traversal errors (a permission, a vanished file) do not turn partial output into no output;
    // find's own exit code is deliberately discarded. Roots are module constants: nothing user-held is spliced.
    const command = `find ${roots.join(" ")} -xdev -newer ${sentinel} -not -type d -print 2>/dev/null || true`;
    const { stdout } = await execFileAsync("sh", ["-c", command], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const paths = stdout.split("\n").filter((line) => line !== "" && !DRIFT_IGNORES.some((ignore) => line.includes(ignore)));
    return collapseDriftPaths(paths);
};

/* One probe of the whole container. Cached briefly because the refresh path recomputes on a click while the
 * sweep recomputes on a timer, and two `find` walks a few seconds apart answer identically. */
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

/* Whether one ledger entry's install is PRESENT in the live container — the corroboration gate that keeps a
 * one-off `docker run` experiment, a failed install, or a stale ledger line from ever becoming a draft. Kind
 * by kind because each ecosystem leaves its mark in a known place, and a targeted stat is both cheaper and
 * sharper than searching the collapsed display paths: a rustup target's rlibs collapse into "toolchains/
 * (500 files)", but the directory NAMED after the target is one stat away. */

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
            // No known landing spot: the display sweep is the only witness. Normalised because pip spells
            // `code-review-graph` and site-packages spells `code_review_graph`.
            const needle = tool.toLowerCase().replaceAll("_", "-");
            return drift.paths.some((path) => path.toLowerCase().replaceAll("_", "-").includes(needle));
        }
    }
};
