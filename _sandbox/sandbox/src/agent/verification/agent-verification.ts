import { extname } from "node:path";
import type { AgentEvent, ToolCallContent, ToolCallStatus } from "@intentic/sandbox-contract";

// Ledger over the turn: which code files changed and whether a passing check followed the last edit. Edits and evidence
// share one counter so order is exact; per-turn, in-memory only, and it never runs a command itself.

// Extensions no suite speaks to; a turn that touched only these is done when it says it is.
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log"]);

// Prose even without a prose extension.
const PROSE_FILENAMES = new Set(["license", "licence", "notice", "authors", "contributors", "changelog", "codeowners"]);

// How much of a failing check's own output rides back with the nudge; enough to act on, not a full re-paste.
const EVIDENCE_DETAIL_MAX = 800;

export type VerificationKind = "test" | "typecheck" | "lint" | "build";

// Reads the tmux wrapper's own footer (`--- [exit N, ...]`), the only way to tell a failed suite from one that merely
// printed failures. Undefined means no footer; the LAST one wins for a compound command.
export const commandExitCode = (response: unknown): number | undefined => {
    const text = typeof response === "string" ? response : typeof response === "object" && response !== null ? JSON.stringify(response) : "";
    const last = [...text.matchAll(/---\s\[exit\s(\d+),/g)].at(-1)?.[1];
    return last === undefined ? undefined : Number(last);
};

// One check the turn ran. `at` is the shared counter, not a clock.
interface Evidence {
    readonly command: string;
    readonly passed: boolean;
    readonly detail: string;
    readonly at: number;
}

export interface VerificationVerdict {
    // Code paths edited with no passing check after them, newest last.
    readonly paths: readonly string[];
    // Last failing check after the final edit, if any; distinct from never having checked.
    readonly failed: Evidence | undefined;
}

// Reports where the turn stands (child-verification.ts), distinct from `verdict`: that goes quiet both when nothing was
// edited and when edits are proven, and a reader needs those told apart.
export type VerificationState = "verified" | "unproven" | "failing" | "no-code";

export interface VerificationStanding {
    readonly state: VerificationState;
    // The code paths edited, deduped, newest last. Empty for `no-code`.
    readonly paths: readonly string[];
    // The command that spoke: cleared it (`verified`) or broke it (`failing`); absent for `unproven`/`no-code`.
    readonly check: string | undefined;
}

export interface VerificationLedger {
    readonly noteEdit: (path: string) => void;
    readonly noteCommand: (command: string, passed: boolean, detail: string) => void;
    // A turn.ending rule's run: evidence by being the declared check, whatever its command would classify as.
    readonly noteCheck: (name: string, passed: boolean, detail: string) => void;
    // Undefined ⇒ nothing to ask for: no code was edited, or a passing check followed the last edit.
    readonly verdict: () => VerificationVerdict | undefined;
    // Every code path edited, deduped, newest last, whether or not it has since been proven.
    readonly edited: () => readonly string[];
    // Where the work stands, for surfaces that report rather than nudge; see VerificationStanding.
    readonly standing: () => VerificationStanding;
}

const isProsePath = (path: string): boolean => {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    return PROSE_EXTENSIONS.has(extname(name)) || PROSE_FILENAMES.has(name.replace(extname(name), ""));
};

// Shell separators that start a new command, each segment classified on its own.
const SEGMENTS = /(?:&&|\|\||;|\|)/;

// Wrappers/prefixes in front of the real command, dropped so classification looks at the token after them.
const RUNNERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx", "run", "exec", "time", "sudo", "env"]);

// The runners a package script is run through; a script name means a check only behind one of them.
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

// Flags that take a value, so the value itself is not mistaken for the command.
const VALUED_FLAGS = new Set(["-C", "--dir", "--filter", "-w", "--workspace"]);

// A segment carrying one of these asks a tool about itself (`bun test --help`) and runs nothing.
const QUERY_FLAGS = new Set(["--help", "-h", "--version"]);

// A version query only as the sole argument (`tsc -v`); beside anything else it is verbose (`go test -v ./...`).
const VERSION_FLAGS = new Set(["-v", "-V"]);

// What a bare token proves, by the binary's basename or the script's name; not exhaustive, an unmatched command is not
// evidence. Strongest first: a command proves the first kind any of its parts does.
const KINDS: ReadonlyArray<readonly [VerificationKind, ReadonlySet<string>]> = [
    ["test", new Set(["test", "verify", "suites", "vitest", "jest", "pytest", "mocha", "ava", "tap", "phpunit", "rspec"])],
    ["typecheck", new Set(["typecheck", "type-check", "tsc", "tsgo", "vue-tsc", "mypy", "pyright", "flow"])],
    ["lint", new Set(["lint", "check", "oxlint", "eslint", "biome", "ruff", "clippy", "flake8", "golangci-lint"])],
    ["build", new Set(["build", "compile", "make", "tsup", "rollup", "vite", "webpack"])],
];

// Names that are checks only as package scripts or tasks: bare, `test` is the shell builtin.
const SCRIPT_NAMES = new Set(["test", "verify", "typecheck", "type-check", "lint", "check", "build", "compile"]);

// `go test ./...` / `cargo test`: the subcommand carries the meaning, not the binary.
const SUBCOMMAND_TOOLS = new Set(["go", "cargo", "dotnet", "mvn", "gradle", "swift", "mix", "rake"]);

// Task runners whose every non-flag argument names a task: `turbo run typecheck test`.
const TASK_RUNNERS = new Set(["turbo"]);

const basename = (token: string): string => token.split("/").pop() ?? token;

const kindOf = (token: string): VerificationKind | undefined => KINDS.find(([, names]) => names.has(token))?.[0];

// A script's `:variant` is the same check narrowed (`verify:turn`, `test:unit`).
const scriptKind = (name: string): VerificationKind | undefined => kindOf(name.split(":")[0] ?? name);

const strongest = (kinds: readonly (VerificationKind | undefined)[]): VerificationKind | undefined =>
    KINDS.map(([kind]) => kind).find((kind) => kinds.includes(kind));

// The tasks a task runner is asked for, past its own `run` and flags.
const taskNames = (args: readonly string[]): string[] => {
    const names: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? "";
        if (VALUED_FLAGS.has(arg)) {
            i += 1;
        } else if (!arg.startsWith("-") && arg !== "run") {
            names.push(arg);
        }
    }
    return names;
};

// The kind one command segment proves, or undefined when it proves nothing.
export const classifyCommand = (segment: string): VerificationKind | undefined => {
    const tokens = segment
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "");
    if (tokens.some((token) => QUERY_FLAGS.has(token))) {
        return undefined;
    }
    let managed = false;
    for (let i = 0; i < tokens.length; i += 1) {
        const raw = tokens[i] ?? "";
        // Leading `FOO=bar` env assignments belong to the command, not to the classification.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
            continue;
        }
        if (VALUED_FLAGS.has(raw)) {
            i += 1;
            continue;
        }
        if (raw.startsWith("-")) {
            continue;
        }
        const token = basename(raw);
        if (RUNNERS.has(token)) {
            managed ||= PACKAGE_MANAGERS.has(token);
            continue;
        }
        const args = tokens.slice(i + 1);
        if (args.length === 1 && VERSION_FLAGS.has(args[0] ?? "")) {
            return undefined;
        }
        if (TASK_RUNNERS.has(token)) {
            return strongest(taskNames(args).map(scriptKind));
        }
        if (SUBCOMMAND_TOOLS.has(token)) {
            // The next non-flag token is the subcommand, `cargo test`, `go build`.
            const next = args.find((t) => !t.startsWith("-"));
            return next === undefined ? undefined : kindOf(basename(next));
        }
        if (managed) {
            return scriptKind(token);
        }
        return SCRIPT_NAMES.has(token) ? undefined : kindOf(token);
    }
    return undefined;
};

// A command proves the strongest thing any of its segments proves: `pnpm lint && pnpm test` is a test run.
const commandKind = (command: string): VerificationKind | undefined => strongest(command.split(SEGMENTS).map(classifyCommand));

export const createVerificationLedger = (): VerificationLedger => {
    // Every edit is recorded, prose included; the prose filter is applied where it's read (`verdict`), not here.
    const edits: { path: string; at: number; prose: boolean }[] = [];
    const evidence: Evidence[] = [];
    let counter = 0;
    const note = (command: string, passed: boolean, detail: string): void => {
        counter += 1;
        evidence.push({ command: command.trim(), passed, detail: detail.slice(0, EVIDENCE_DETAIL_MAX), at: counter });
    };
    // Only code counts, so a turn that touched nothing else is done already; order means after the last edit a check
    // could speak to. `paths` is deduped, newest last.
    const read = (): { readonly paths: readonly string[]; readonly after: readonly Evidence[] } => {
        const code = edits.filter((edit) => !edit.prose);
        const lastEdit = code.at(-1);
        if (lastEdit === undefined) {
            return { paths: [], after: [] };
        }
        return {
            paths: [...new Set(code.map((edit) => edit.path))],
            after: evidence.filter((item) => item.at > lastEdit.at),
        };
    };
    return {
        noteEdit: (path) => {
            counter += 1;
            edits.push({ path, at: counter, prose: isProsePath(path) });
        },
        noteCommand: (command, passed, detail) => {
            if (commandKind(command) !== undefined) {
                note(command, passed, detail);
            }
        },
        noteCheck: note,
        edited: () => [...new Set(edits.map((edit) => edit.path))],
        verdict: () => {
            const { paths, after } = read();
            if (paths.length === 0 || after.some((item) => item.passed)) {
                return undefined;
            }
            const failed = after.findLast((item) => !item.passed);
            return { paths, ...(failed !== undefined ? { failed } : { failed: undefined }) };
        },
        standing: () => {
            const { paths, after } = read();
            if (paths.length === 0) {
                return { state: "no-code", paths, check: undefined };
            }
            // A pass anywhere after the last edit clears it; the last such pass is the one named.
            const passed = after.findLast((item) => item.passed);
            if (passed !== undefined) {
                return { state: "verified", paths, check: passed.command };
            }
            const failed = after.findLast((item) => !item.passed);
            return failed === undefined ? { state: "unproven", paths, check: undefined } : { state: "failing", paths, check: failed.command };
        },
    };
};

// Same ledger fed normalized frames (`tool_call`/`tool_call_update`, agent/tool-calls.ts) instead of hooks, so the
// verdict works on any runtime. Remembered when a call opens, noted when it settles; a failed edit is not recorded.
export interface FrameLedger extends VerificationLedger {
    // Feed one frame; frames this ledger has no use for cost only a comparison.
    readonly note: (event: AgentEvent) => void;
}

// What one tool call is to this ledger: work waiting for proof, a check that might supply it, or neither.
type TrackedCall = { readonly kind: "edit"; readonly paths: readonly string[] } | { readonly kind: "check"; readonly command: string };

// Exported so a caller keying ledgers by owner (child-verification.ts) can tell a call apart before opening one. Paths
// come from `locations`, or a diff's own path when an ACP agent sends the change itself.
export const trackedCall = (event: Extract<AgentEvent, { kind: "tool_call" }>): TrackedCall | undefined => {
    if (event.category === "edit") {
        const located = (event.locations ?? []).map((location) => location.path);
        const diffed = (event.content ?? []).flatMap((entry) => (entry.type === "diff" ? [entry.path] : []));
        const touched = located.length > 0 ? located : diffed;
        return touched.length > 0 ? { kind: "edit", paths: touched } : undefined;
    }
    return event.category === "execute" && event.target !== undefined ? { kind: "check", command: event.target } : undefined;
};

export const createFrameLedger = (): FrameLedger => {
    const ledger = createVerificationLedger();
    const pending = new Map<string, TrackedCall>();
    // A call's result, once it has one; interim updates leave it pending, only a terminal status is an answer
    // (activity/outbound.ts).
    const settle = (id: string, status: ToolCallStatus | undefined, content: readonly ToolCallContent[] | undefined): void => {
        if (status !== "completed" && status !== "failed") {
            return;
        }
        const call = pending.get(id);
        if (call === undefined) {
            return;
        }
        pending.delete(id);
        if (call.kind === "edit") {
            if (status === "completed") {
                for (const path of call.paths) {
                    ledger.noteEdit(path);
                }
            }
            return;
        }
        const text = content?.find((entry) => entry.type === "text")?.text ?? "";
        // Exit code outranks the tool's own status: a suite that exited 1 can still show as a completed call.
        const exit = commandExitCode(text);
        ledger.noteCommand(call.command, exit === undefined ? status === "completed" : exit === 0, text);
    };
    return {
        ...ledger,
        note: (event) => {
            if (event.kind === "tool_call_update") {
                settle(event.id, event.status, event.content);
                return;
            }
            if (event.kind !== "tool_call") {
                return;
            }
            const call = trackedCall(event);
            if (call === undefined) {
                return;
            }
            pending.set(event.id, call);
            settle(event.id, event.status, event.content);
        },
    };
};
