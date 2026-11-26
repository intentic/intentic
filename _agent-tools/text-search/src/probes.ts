import { anySignal } from "@intentic/base/async";
import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";
import { RAN_LITERAL_NOTE, scanText, type TextFind, type TextScanOptions } from "./text-search.js";
import { normalized, runRg } from "./walk.js";

// What a search that found nothing would have found with one switch changed: any case, ignored and hidden files in, the
// pattern read as plain text. A bare "no matches" leaves the asker to guess which it was, and an agent guesses by running
// casing variants one at a time; each probe changes exactly one switch, so the probe that matches names the cause and
// the files. The idea is hermes-agent's zero-match probes (tools/file_operations_search.py), not its code.
//
// Two front ends, one per reading of a search: `probeRgSearch` for rg as a shell or an agent's Grep tool runs it
// (ripgrep's own ignore rules), `probeTextFind` for the search box's walk (text-search.ts). output-cleaners keeps a
// builtins-only copy of the rg reading and of `probeNote` for shell commands (src/search-probes.mjs), held to these by
// its tests.

export type ProbeKind = "case" | "ignored" | "literal";

export interface ProbeHit {
    readonly kind: ProbeKind;
    // Files that would match; a floor when `more`.
    readonly files: number;
    // Stopped before rg finished (the budget ran out, or FILE_CAP files were listed): more may match.
    readonly more: boolean;
    // The first few in path order.
    readonly examples: readonly string[];
}

// All probes run side by side, killed together once this is spent.
export const PROBE_BUDGET_MS = 1_500;
const EXAMPLES = 3;
// Files listed per probe before it stops: enough for a count worth saying, never a walk of the whole tree.
const FILE_CAP = 200;

// Regex syntax that reads differently as plain text. A dot is left out: as a regex it matches a dot too, so a pattern
// whose only metacharacter is a dot finds everything its plain text would.
export const REGEX_SYNTAX = /[\\[\](){}?*+^$|]/;

// Whether ignoring case can find anything more: only for a pattern with a cased letter.
export const hasCase = (pattern: string): boolean => pattern.toLowerCase() !== pattern.toUpperCase();

// Trees the ignored-and-hidden probe still leaves out: version control, installed dependencies, caches and Rust's build
// tree. Walking node_modules made the probe take 5 s on this monorepo where it took 30 to 290 ms without (2026-11-26),
// and a match in one is rarely the file meant. Other build output (dist, build) stays in: a string found only in a bundle
// is this probe's best answer. A tree named as the search's own path is still searched (rg matches globs below it).
const PROBE_PRUNED_DIRS = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".pnpm-store",
    ".yarn",
    ".npm",
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
    ".cache",
    ".turbo",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    ".m2",
    "target",
];

// The globs the ignored probe prunes with: those trees at any depth, then the workspace's machine state and reference
// shelf, by far the largest trees under /work (to walk: refs 8.9 s, .intentic/records 3.0 s, .intentic/local 1.7 s,
// 2026-11-26). The shelf is anchored where rg runs, as a repository's own refs/ is ordinary content.
export const PROBE_PRUNE_GLOBS = [
    ...PROBE_PRUNED_DIRS.map((dir) => `!**/${dir}`),
    `!/${REFERENCE_DIR}`,
    `!**/${STATE_DIR}/local`,
    `!**/${STATE_DIR}/records`,
];

// How each probe is named to the one who searched. The defaults speak rg's flags; a caller with other switches (the
// Grep tool, the search box) names its own.
export type ProbeLabels = Readonly<Record<ProbeKind, string>>;
export const RG_LABELS = {
    case: "case-insensitive (-i)",
    ignored: "in ignored/hidden files (-uu)",
    literal: "as literal text (-F)",
} as const satisfies ProbeLabels;

const counted = (hit: ProbeHit): string => `${String(hit.files)}${hit.more ? "+" : ""} ${hit.files === 1 && !hit.more ? "file" : "files"}`;
const examplesOf = (hit: ProbeHit): string => `${hit.examples.join(", ")}${hit.more || hit.files > hit.examples.length ? ", …" : ""}`;

// One line for whoever searched: each probe that matched, how many files and the first few. Undefined when none did, so a
// string that is genuinely absent costs nothing to say.
export const probeNote = (hits: readonly ProbeHit[], labels: ProbeLabels = RG_LABELS): string | undefined =>
    hits.length === 0
        ? undefined
        : `no matches. Would match: ${hits.map((hit) => `${labels[hit.kind]} → ${counted(hit)} (${examplesOf(hit)})`).join("; ")}`;

const hitOf = (kind: ProbeKind, found: readonly string[], more: boolean): ProbeHit | undefined => {
    if (found.length === 0) {
        return undefined;
    }
    const sorted = found.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { kind, files: found.length, more, examples: sorted.slice(0, EXAMPLES) };
};

// A search as rg reads it on a command line: its own ignore files, hidden files out, case-sensitive unless told.
export interface RgSearch {
    // Where rg runs; relative paths are read from here, and listed paths under it are said relative to it.
    readonly cwd: string;
    readonly pattern: string;
    // What was searched; none is the cwd.
    readonly paths?: readonly string[] | undefined;
    // The search's own selection flags (globs, types, -w, -U …), kept in every probe. Never output flags: each probe
    // lists files.
    readonly flags?: readonly string[] | undefined;
    readonly literal?: boolean | undefined;
    readonly ignoreCase?: boolean | undefined;
    // The search already looked in hidden files, or in ignored ones.
    readonly hidden?: boolean | undefined;
    readonly noIgnore?: boolean | undefined;
}

export interface ProbeOptions {
    readonly rgPath?: string | undefined;
    // The caller letting go: every probe's rg is killed.
    readonly signal?: AbortSignal | undefined;
    readonly budgetMs?: number | undefined;
    // Runs rg somewhere else, another mount namespace: handed rg's argv, answers the one to spawn, which sets its own
    // working directory.
    readonly enter?: ((command: string, args: readonly string[]) => { readonly command: string; readonly args: readonly string[] }) | undefined;
}

interface RgProbe {
    readonly kind: ProbeKind;
    readonly flags: readonly string[];
}

const PRUNE_GLOBS = PROBE_PRUNE_GLOBS.flatMap((glob) => ["-g", glob]);

// Each probe that could find what the search did not, as the flags it adds. The pruning goes before the search's own
// globs, which rg lets win.
const rgProbes = (search: RgSearch): RgProbe[] => {
    const flags = search.flags ?? [];
    const probes: RgProbe[] = [];
    if (search.ignoreCase !== true && hasCase(search.pattern)) {
        probes.push({ kind: "case", flags: [...flags, "-i"] });
    }
    if (search.hidden !== true || search.noIgnore !== true) {
        probes.push({ kind: "ignored", flags: [...PRUNE_GLOBS, ...flags, "--no-ignore", "--hidden"] });
    }
    if (search.literal !== true && REGEX_SYNTAX.test(search.pattern)) {
        probes.push({ kind: "literal", flags: [...flags, "-F"] });
    }
    return probes;
};

// The files one probe lists, as far as it got before the budget or the cap stopped it.
const listed = async (search: RgSearch, probe: RgProbe, options: ProbeOptions, signal: AbortSignal): Promise<ProbeHit | undefined> => {
    // Never no paths at all: rg would read its stdin, which runRg closes at once.
    const paths = search.paths === undefined || search.paths.length === 0 ? ["./"] : search.paths;
    const args = ["--no-config", ...probe.flags, "--files-with-matches", "-e", search.pattern, "--", ...paths];
    const spawned = options.enter?.(options.rgPath ?? "rg", args) ?? { command: options.rgPath ?? "rg", args };
    const found: string[] = [];
    const said = (path: string): string => normalized(path.startsWith(`${search.cwd}/`) ? path.slice(search.cwd.length + 1) : path);
    let more: boolean;
    try {
        const run = await runRg(spawned.command, options.enter === undefined ? search.cwd : "/", spawned.args, signal, (line) => {
            found.push(said(line));
            return found.length < FILE_CAP;
        });
        more = run.stopped;
    } catch {
        // allow(silent-catch): the budget ran out, or rg could not start; whatever it listed before is still true.
        more = true;
    }
    return hitOf(probe.kind, found, more);
};

// The probes for an rg search that found nothing, side by side within the budget: those that matched, in probe order.
// A caller that let go wants nothing back, not what a probe managed before its abort landed: spawn with an aborted
// signal kills rg a tick late, and under load it has listed a file by then. The probes' own budget is not this: what a
// budget-stopped probe found is still true, and is said as a floor.
const letGo = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export const probeRgSearch = async (search: RgSearch, options: ProbeOptions = {}): Promise<ProbeHit[]> => {
    if (letGo(options.signal)) {
        return [];
    }
    const signal = anySignal(options.signal, AbortSignal.timeout(options.budgetMs ?? PROBE_BUDGET_MS));
    const hits = await Promise.all(rgProbes(search).map(async (probe) => listed(search, probe, options, signal)));
    return letGo(options.signal) ? [] : hits.filter((hit): hit is ProbeHit => hit !== undefined);
};

// The search box's own switches, flipped one at a time over the same walk: any case when it asked for case, ignored files
// when it left them out (pruned as the rg probe is, or every empty answer would wait out the budget walking
// node_modules), plain text when the pattern holds regex syntax. Each runs the box's scan, so the floor and the scope hold.
const textProbes = (options: TextScanOptions): { kind: ProbeKind; options: TextScanOptions }[] => {
    const probes: { kind: ProbeKind; options: TextScanOptions }[] = [];
    if (options.caseSensitive === true && hasCase(options.pattern)) {
        probes.push({ kind: "case", options: { ...options, caseSensitive: false } });
    }
    if (options.ignored !== true) {
        probes.push({ kind: "ignored", options: { ...options, ignored: true, prune: [...(options.prune ?? []), ...PROBE_PRUNE_GLOBS] } });
    }
    if (options.literal !== true && REGEX_SYNTAX.test(options.pattern)) {
        probes.push({ kind: "literal", options: { ...options, literal: true } });
    }
    return probes;
};

const scanned = async (kind: ProbeKind, options: TextScanOptions, signal: AbortSignal): Promise<ProbeHit | undefined> => {
    const found: string[] = [];
    let more: boolean;
    try {
        const scan = await scanText({ ...options, signal, maxHits: FILE_CAP, onGroup: (group) => found.push(group.path) });
        more = scan.ceiling;
    } catch {
        // allow(silent-catch): the budget ran out, or the pattern does not read this way; what was found is still true.
        more = true;
    }
    return hitOf(kind, found, more);
};

// The probes for a box search that found nothing, within the budget (and the caller's signal).
export const probeTextFind = async (options: TextScanOptions, budgetMs = PROBE_BUDGET_MS): Promise<ProbeHit[]> => {
    if (letGo(options.signal)) {
        return [];
    }
    const signal = anySignal(options.signal, AbortSignal.timeout(budgetMs));
    const hits = await Promise.all(textProbes(options).map(async (probe) => scanned(probe.kind, probe.options, signal)));
    return letGo(options.signal) ? [] : hits.filter((hit): hit is ProbeHit => hit !== undefined);
};

// The probes for a box search's answer: none unless it found nothing and was not cut short, and a pattern already run
// again as plain text is probed as plain text.
export const probeFound = async (options: TextScanOptions, found: TextFind, budgetMs = PROBE_BUDGET_MS): Promise<ProbeHit[]> =>
    found.groups.length > 0 || found.ceiling ? [] : probeTextFind({ ...options, literal: options.literal === true || found.note === RAN_LITERAL_NOTE }, budgetMs);
