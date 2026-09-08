import { execFile } from "node:child_process";
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

// Cleared by the card's refresh button, so a fresh install doesn't need a restart to show up.
export const clearVersionCache = (): void => cache.clear();

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
