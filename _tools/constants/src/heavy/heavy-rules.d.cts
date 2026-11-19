// Types for heavy-rules.cjs, the one heavy-command table the daemon, the program hook and the scripts read.
export type OnDeadline = "run" | "skip";

export interface HeavyCommandRule {
    readonly id: string;
    // JS regex source, case-insensitive, matched against `<program> <args…>` of the program that runs. Absent only on a
    // declared class that names scripts alone.
    readonly pattern?: string | undefined;
    readonly pool?: string | undefined;
    readonly limit?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly exempt?: boolean | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    // A regex the program's working directory must match too, for what its arguments cannot name.
    readonly cwd?: string | undefined;
    // The memory gate's price by name (memory-room.mjs SIZE_BYTES) instead of its class's; an unknown name is the class.
    readonly size?: string | undefined;
    // Judged even under a program already holding a slot, while every held pool is one no `nests` rule names.
    readonly nests?: boolean | undefined;
    // Started through heavy-launch.cjs, which sets this tool's jobs and test threads from its room (`cargo`).
    readonly parallel?: "cargo" | undefined;
    // From a project's declared class (classRules): the repo-relative scripts it is, matched by path; the cores it keeps
    // busy, waited for and handed to it as INTENTIC_CPUS; whether it is pinned to that many idle cores; whether nothing
    // else heavy may run beside it (`exclusive`), or the machine must also be calm (`quiet`).
    readonly scripts?: readonly string[] | undefined;
    readonly cpus?: number | undefined;
    readonly pin?: boolean | undefined;
    readonly exclusive?: boolean | undefined;
    readonly quiet?: boolean | undefined;
    // A declared class's rule, and the words the interpreters' wrapper looks for before it asks for a judgement.
    readonly declared?: boolean | undefined;
    readonly words?: readonly string[] | undefined;
}

// A heavy command a repository declares in its `.intentic/heavy.json` (`classes`), parsed at that boundary
// (workload/heavy-classes.ts): what it is, how much it takes, and how it shares the sandbox.
export interface HeavyClass {
    // Names the rule, the pool (unless `group` does) and the lines the queue prints.
    readonly id: string;
    // Repo-relative paths of the scripts it is (`scripts/capture.py`), whatever runs them.
    readonly scripts?: readonly string[] | undefined;
    // The first words of the commands it is (`npm run e2e`), matched against the program that runs and its arguments.
    readonly commands?: readonly string[] | undefined;
    // What it holds at its peak (`6G`, `512M`): the memory gate's price for it.
    readonly memory?: string | undefined;
    readonly cpus?: number | undefined;
    readonly pin?: boolean | undefined;
    // How many may run at once across the sandbox (1 by default); classes naming one `group` share one pool.
    readonly limit?: number | undefined;
    readonly group?: string | undefined;
    readonly exclusive?: boolean | undefined;
    readonly quiet?: boolean | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly onDeadline?: OnDeadline | undefined;
}

// An owner's change to the table: a shipped rule's id changes the fields it names, or removes it (`disabled`); any other
// id, with a pattern, is the owner's own rule.
export interface HeavyCommandRuleEdit {
    readonly id: string;
    readonly pattern?: string | undefined;
    readonly pool?: string | undefined;
    readonly limit?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly exempt?: boolean | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    // A regex the program's working directory must match too, for what its arguments cannot name.
    readonly cwd?: string | undefined;
    // The memory gate's price by name (memory-room.mjs SIZE_BYTES) instead of its class's; an unknown name is the class.
    readonly size?: string | undefined;
    // Judged even under a program already holding a slot, while every held pool is one no `nests` rule names.
    readonly nests?: boolean | undefined;
    readonly exclusive?: boolean | undefined;
    readonly quiet?: boolean | undefined;
    readonly cpus?: number | undefined;
    readonly pin?: boolean | undefined;
    readonly disabled?: boolean | undefined;
}

export interface HeavyCommandSettings {
    readonly limit: number;
    readonly defaultPool: string;
    readonly waitSeconds: number;
    readonly memoryGateSeconds: number;
    readonly maxHoldSeconds: number;
    readonly onDeadline: OnDeadline;
}

export interface HeavyCommandOverrides {
    readonly limit?: number | undefined;
    readonly defaultPool?: string | undefined;
    readonly waitSeconds?: number | undefined;
    readonly memoryGateSeconds?: number | undefined;
    readonly maxHoldSeconds?: number | undefined;
    readonly onDeadline?: OnDeadline | undefined;
    readonly queue?: boolean | undefined;
    readonly ruleEdits?: readonly HeavyCommandRuleEdit[] | undefined;
}

export interface HeavyCommands extends HeavyCommandSettings {
    // False stops queueing; heavy programs keep their class either way.
    readonly queue: boolean;
    readonly rules: readonly HeavyCommandRule[];
}

export interface HeavyMatch {
    readonly id: string;
    readonly pool: string;
    readonly limit: number;
    readonly maxHold: number;
    readonly onDeadline: OnDeadline;
    readonly size?: string;
    readonly cpus?: number;
    readonly pin?: boolean;
    readonly exclusive?: boolean;
    readonly quiet?: boolean;
    readonly parallel?: "cargo";
}

// Where a program runs, for the rules that look past its arguments.
export interface MatchWhere {
    readonly cwd?: string | undefined;
    // Its arguments (and a node program's script) as absolute paths, for a declared class's `scripts`.
    readonly paths?: readonly string[] | undefined;
    // The pools programs above it already hold slots of (heldPoolsOf).
    readonly heldPools?: readonly string[] | undefined;
}

export const QUEUE_SKIPPED_EXIT_CODE: 75;
export const MATCH_LIMIT: number;
export const SHIPPED_HEAVY_COMMANDS: HeavyCommandSettings & { readonly rules: readonly HeavyCommandRule[] };
export const EARLIER_SHIPPED_RULES: readonly HeavyCommandRule[];
export function mergeHeavyRules(overrides?: HeavyCommandOverrides, classes?: readonly HeavyClass[]): HeavyCommands;
// A project's declared classes as rules, before the shipped table; a class naming nothing it can match is left out.
export function classRules(classes?: readonly HeavyClass[]): HeavyCommandRule[];
// The words the interpreters' wrapper looks for (INTENTIC_HEAVY_WORDS); empty when no declared class is in force.
export function heavyWords(config: HeavyCommands): string[];
// `6G`, `512M`, `1.5GiB` or a bare number of MiB, as MiB; undefined for anything else.
export function memoryMibOf(text: string): number | undefined;
// A declared script as the rule keeps it (repo-relative, no `./`); undefined for an absolute path, `..` or whitespace.
export function scriptPathOf(text: string): string | undefined;
export function overridesOf(full: Partial<HeavyCommandSettings> & { readonly rules?: readonly HeavyCommandRule[] | undefined }): HeavyCommandOverrides;
export function matchInvocation(invocation: string, config: HeavyCommands, report?: (detail: string) => void, where?: MatchWhere): HeavyMatch | undefined;
export function queueArgs(match: HeavyMatch, config: HeavyCommandSettings): string[];
// Whether a test invocation names the files it runs, for the memory gate's smaller price.
export function targetedRun(invocation: string): boolean;
// queue-run's `--size <name>`: the rule's own size, else `targeted` for a targeted test run under a test rule, else nothing.
export function sizeArgs(match: HeavyMatch, invocation: string): string[];
export function holdWarnSeconds(maxHold: number): number | undefined;
export function ruleById(config: HeavyCommands, id: string): HeavyCommandRule | undefined;
// The pools the programs above one already hold slots of, from INTENTIC_HEAVY_HELD and INTENTIC_QUEUE_SLOT.
export function heldPoolsOf(env: Readonly<Record<string, string | undefined>>, config: HeavyCommands): string[];

// The build before a cargo run, or undefined when its arguments cannot be translated safely.
export function cargoBuildArgs(args: readonly string[]): string[] | undefined;
