import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

// Versions are read from the binaries themselves, not recipe pins: a pin describes what the next rebuild installs, not
// what the container has now. Exempted from the visible-tmux rule in terminal-run.ts, since this is not a user action.

const execFileAsync = promisify(execFile);

// Flags tried in order; `-version` (ffmpeg, java's spelling) is checked second since nothing else uses it.
const VERSION_FLAGS = ["--version", "-version"];

// Generous: a slow probe must read as slow, not missing; timeouts are never cached (see probeVersion).
const PROBE_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024;

// Re-probed after this so a tool installed mid-session stops reading as pending without a container recreate.
const CACHE_TTL_MS = 5 * 60 * 1_000;

interface Probe {
    readonly version: string | undefined;
    readonly found: boolean;
    readonly at: number;
}

const cache = new Map<string, Probe>();
const moduleCache = new Map<string, Probe>();
const packageCache = new Map<string, Probe>();

export interface ModuleProbeTarget {
    readonly name: string;
    readonly manifest: string;
}

// Cleared by the card's refresh button, so a fresh install doesn't need a restart to show up.
export const clearVersionCache = (): void => {
    cache.clear();
    moduleCache.clear();
    packageCache.clear();
};

// First dotted number in the tool's output (`rustc 1.90.0`, `ffmpeg version 6.1.1-3`, a bare `1.2.4` from bun); build
// metadata after it is dropped.
export const parseVersion = (output: string): string | undefined => /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1];

// One tool's version, or undefined if it has none; `found` distinguishes that from missing entirely. Any failure but
// ENOENT/EACCES still proves the binary exists, so it falls through to the next flag.
const probeOnce = async (bin: string): Promise<Probe & { readonly timedOut: boolean }> => {
    let found = false;
    let timedOut = false;
    for (const flag of VERSION_FLAGS) {
        try {
            const { stdout, stderr } = await execFileAsync(bin, [flag], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
            const version = parseVersion(stdout) ?? parseVersion(stderr);
            if (version !== undefined) {
                return { version, found: true, at: Date.now(), timedOut: false };
            }
            found = true;
        } catch (error) {
            // ENOENT/EACCES is the only case that means no such command; other errors still came from a real binary.
            const code = (error as { code?: unknown }).code;
            if (code === "ENOENT" || code === "EACCES") {
                return { version: undefined, found: false, at: Date.now(), timedOut: false };
            }
            const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
            const version = parseVersion(output);
            if (version !== undefined) {
                return { version, found: true, at: Date.now(), timedOut: false };
            }
            // A killed process answered nothing because we stopped asking, not because it had nothing to say.
            timedOut = timedOut || (error as { killed?: boolean }).killed === true || code === "ETIMEDOUT";
            found = true;
        }
    }
    return { version: undefined, found, at: Date.now(), timedOut };
};

const probeVersion = async (bin: string): Promise<Probe> => {
    const cached = cache.get(bin);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached;
    }
    const { timedOut, ...probe } = await probeOnce(bin);
    // Timeouts are not cached, or one busy moment holds a present tool at 'unknown' for the rest of the window.
    if (!timedOut) {
        cache.set(bin, probe);
    }
    return probe;
};

// Deduplicates candidates (callers' lists overlap) so cost scales with distinct binaries, not the recipe.
export const probeAll = async (bins: Iterable<string>): Promise<Map<string, Probe>> => {
    const unique = [...new Set(bins)];
    const probes = await Promise.all(unique.map(async (bin) => [bin, await probeVersion(bin)] as const));
    return new Map(probes);
};

const probeModuleOnce = async (manifest: string): Promise<Probe> => {
    try {
        const version = (JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown }).version;
        return typeof version === "string" && version !== ""
            ? { version, found: true, at: Date.now() }
            : { version: undefined, found: true, at: Date.now() };
    } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") {
            return { version: undefined, found: false, at: Date.now() };
        }
        throw error;
    }
};

const probeModule = async (target: ModuleProbeTarget): Promise<Probe> => {
    const cached = moduleCache.get(target.manifest);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached;
    }
    const probe = await probeModuleOnce(target.manifest);
    moduleCache.set(target.manifest, probe);
    return probe;
};

// `ii` is dpkg's installed-and-configured; anything else (removed, config-only, half-installed) is not on disk.
const DPKG_FORMAT = "${Package}|${db:Status-Abbrev}|${Version}\\n";

// dpkg exits 1 when any name is unknown yet still prints the rest, so the output is read either way; no dpkg at all
// (a non-Debian host) reads as nothing installed.
const queryDpkg = async (packages: readonly string[]): Promise<string> => {
    try {
        return (await execFileAsync("dpkg-query", ["-W", `-f=${DPKG_FORMAT}`, ...packages], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER })).stdout;
    } catch (error) {
        return (error as { stdout?: string }).stdout ?? "";
    }
};

// An apt package by name, for the ones whose name is no command (imagemagick ships `magick`, sysstat `iostat`); the
// version is the package's own with its epoch dropped, so `8:7.1.1.43+dfsg1` reads 7.1.1.
export const probePackages = async (packages: Iterable<string>): Promise<Map<string, Probe>> => {
    const now = Date.now();
    const result = new Map<string, Probe>();
    const stale: string[] = [];
    for (const name of new Set(packages)) {
        const cached = packageCache.get(name);
        if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
            result.set(name, cached);
        } else {
            stale.push(name);
        }
    }
    if (stale.length === 0) {
        return result;
    }
    const installed = new Map<string, string>();
    for (const line of (await queryDpkg(stale)).split("\n")) {
        const [name, status, version] = line.split("|");
        if (name !== undefined && status?.startsWith("ii") === true) {
            installed.set(name, version ?? "");
        }
    }
    for (const name of stale) {
        const version = installed.get(name);
        const probe: Probe = { version: version === undefined ? undefined : parseVersion(version.replace(/^\d+:/, "")), found: version !== undefined, at: now };
        packageCache.set(name, probe);
        result.set(name, probe);
    }
    return result;
};

// Prefix-installed npm modules have no binary on PATH; their manifest is the probe target.
export const probeModules = async (targets: Iterable<ModuleProbeTarget>): Promise<Map<string, Probe>> => {
    const unique = new Map<string, ModuleProbeTarget>();
    for (const target of targets) {
        unique.set(target.name, target);
    }
    const probes = await Promise.all([...unique.values()].map(async (target) => [target.name, await probeModule(target)] as const));
    return new Map(probes);
};
