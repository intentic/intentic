import { execFile } from "node:child_process";
import { promisify } from "node:util";

/* ASKING THE SANDBOX WHAT IT ACTUALLY HAS.
 *
 * The Environment tab's contents view shows a version beside each tool, and there are two places it could come
 * from: the install line in the recipe, or the tool itself. It has to be the tool. A recipe pins nothing at all
 * for half these entries (`bun`, and a rustup line whose toolchain is `stable`), and where it DOES pin a number
 * that number describes what the next rebuild would install — so an overlay that is approved and not yet built
 * would report versions for tools the container does not have. Reading them back from the binaries makes the
 * whole view true by construction, and it makes per-item state exact for free: an item the recipe contains and
 * this module cannot find is precisely one that arrives with the next rebuild.
 *
 * A probe is one of the reads that terminal-run.ts exempts from the visible-tmux rule — nothing here is a user
 * action, and forty version checks in the terminals panel would be noise, not transparency. */

const execFileAsync = promisify(execFile);

// The flags tools answer a version on, in the order worth trying. `-version` is second because it is ffmpeg's
// (and java's) spelling and nothing else's; a tool that takes neither is reported as having no version, never as
// missing — the difference decides whether the row says "arrives after rebuild".
const VERSION_FLAGS = ["--version", "-version"];

// Long enough for a JVM-ish cold start, short enough that a hung binary cannot hold the whole view. A probe that
// times out reads as "no version", the same as one that answers nothing.
const PROBE_TIMEOUT_MS = 3_000;
const MAX_BUFFER = 64 * 1024;

// Re-probed after this, so a tool an agent installed mid-session stops being reported as pending forever. The
// applied environment cannot otherwise change without a container recreate, which restarts this process anyway.
const CACHE_TTL_MS = 5 * 60 * 1_000;

interface Probe {
    readonly version: string | undefined;
    readonly found: boolean;
    readonly at: number;
}

const cache = new Map<string, Probe>();

// The card's refresh button clears this, so "it says missing but I just installed it" has an answer that is one
// click rather than a restart.
export const clearVersionCache = (): void => cache.clear();

/* The version out of whatever the tool printed. Tools are wildly inconsistent here — `rustc 1.90.0`,
 * `ffmpeg version 6.1.1-3`, `Docker version 27.3.1, build ce1223035a`, a bare `1.2.4` from bun — but they all
 * lead with a dotted number, so the first one is the answer. Build metadata after it is dropped: the row has
 * space for a version, and "6.1.1" is the part anyone compares. */
export const parseVersion = (output: string): string | undefined => /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1];

/* ONE TOOL'S VERSION, or undefined when it has none to give. `found` is the load-bearing half: a binary that is
 * not on PATH throws ENOENT, and everything else — a non-zero exit, an unknown flag, a timeout — still proves
 * the command exists, which is why those fall through to the next flag and then to "present, version unknown"
 * rather than to "missing". Reporting a tool as absent because it dislikes `--version` would put a working
 * toolchain behind a "needs a rebuild" badge. */
const probeOnce = async (bin: string): Promise<Probe> => {
    let found = false;
    for (const flag of VERSION_FLAGS) {
        try {
            const { stdout, stderr } = await execFileAsync(bin, [flag], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
            const version = parseVersion(stdout) ?? parseVersion(stderr);
            if (version !== undefined) {
                return { version, found: true, at: Date.now() };
            }
            found = true;
        } catch (error) {
            // ENOENT is the only answer that means "no such command"; a tool that exits non-zero on an unknown
            // flag still printed its usage from a real binary, and often its version with it.
            const code = (error as { code?: unknown }).code;
            if (code === "ENOENT" || code === "EACCES") {
                return { version: undefined, found: false, at: Date.now() };
            }
            const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
            const version = parseVersion(output);
            if (version !== undefined) {
                return { version, found: true, at: Date.now() };
            }
            found = true;
        }
    }
    return { version: undefined, found, at: Date.now() };
};

const probeVersion = async (bin: string): Promise<Probe> => {
    const cached = cache.get(bin);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached;
    }
    const probe = await probeOnce(bin);
    cache.set(bin, probe);
    return probe;
};

// Every distinct command, probed once. Callers hand in overlapping candidate lists (two blocks can both install
// `cargo`), so deduping here is what keeps the view's cost proportional to the sandbox rather than to the recipe.
export const probeAll = async (bins: Iterable<string>): Promise<Map<string, Probe>> => {
    const unique = [...new Set(bins)];
    const probes = await Promise.all(unique.map(async (bin) => [bin, await probeVersion(bin)] as const));
    return new Map(probes);
};
