import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { AgentEvent, ToolCallContent, ToolCallStatus } from "@intentic/sandbox-contract";
import { inWorktree, type IsolationPlan } from "../../agents/worktrees/isolation.js";
import { onPath } from "../../platform/boot/on-path.js";

// Ledger over the turn, not a per-edit check: tracks which code files changed and what commands ran, and asks once
// whether a passing check followed the last edit. Edits and evidence share one counter so order is exact; per-turn,
// in-memory only. Never runs a command itself and never nudges on a turn that only touched prose.

// Extensions no suite speaks to; a turn that touched only these is done when it says it is.
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log"]);

// Prose even without a prose extension.
const PROSE_FILENAMES = new Set(["license", "licence", "notice", "authors", "contributors", "changelog", "codeowners"]);

// How much of a failing check's own output rides back with the nudge; enough to act on, not a full re-paste.
const EVIDENCE_DETAIL_MAX = 800;

// Scripts worth suggesting, most important first; offered only if the workspace actually defines them.
const SUGGESTED_SCRIPTS = ["test", "typecheck", "check", "lint", "build"] as const;

export type VerificationKind = "test" | "typecheck" | "lint" | "build";

// Reads the tmux wrapper's own footer (`--- [exit N, ...]`), the only way to tell a failed suite from one that merely
// printed failures. Undefined means no footer; the LAST one wins for a compound command.
export const commandExitCode = (response: unknown): number | undefined => {
    const text = typeof response === "string" ? response : typeof response === "object" && response !== null ? JSON.stringify(response) : "";
    const last = [...text.matchAll(/---\s\[exit\s(\d+),/g)].at(-1)?.[1];
    return last === undefined ? undefined : Number(last);
};

// One classified command the turn ran. `at` is the shared counter, not a clock.
interface Evidence {
    readonly kind: VerificationKind;
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

// Flags that take a value, so the value itself is not mistaken for the command.
const VALUED_FLAGS = new Set(["-C", "--dir", "--filter", "-w", "--workspace"]);

// What a bare token proves, by the binary's basename; not exhaustive, an unmatched command is not evidence.
const KINDS: ReadonlyArray<readonly [VerificationKind, ReadonlySet<string>]> = [
    ["test", new Set(["test", "vitest", "jest", "pytest", "mocha", "ava", "tap", "phpunit", "rspec"])],
    ["typecheck", new Set(["typecheck", "type-check", "tsc", "tsgo", "vue-tsc", "mypy", "pyright", "flow"])],
    ["lint", new Set(["lint", "check", "oxlint", "eslint", "biome", "ruff", "clippy", "flake8", "golangci-lint"])],
    ["build", new Set(["build", "compile", "make", "tsup", "rollup", "vite", "webpack"])],
];

// `go test ./...` / `cargo test` / `dotnet test`: the subcommand carries the meaning, not the binary.
const SUBCOMMAND_TOOLS = new Set(["go", "cargo", "dotnet", "mvn", "gradle", "swift", "mix", "rake"]);

const basename = (token: string): string => token.split("/").pop() ?? token;

// The kind one command segment proves, or undefined when it proves nothing.
export const classifyCommand = (segment: string): VerificationKind | undefined => {
    const tokens = segment
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "");
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
            continue;
        }
        if (SUBCOMMAND_TOOLS.has(token)) {
            // The next non-flag token is the subcommand, `cargo test`, `go build`.
            const next = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
            return next === undefined ? undefined : kindOf(basename(next));
        }
        return kindOf(token);
    }
    return undefined;
};

const kindOf = (token: string): VerificationKind | undefined => KINDS.find(([, names]) => names.has(token))?.[0];

// A command proves the strongest thing any of its segments proves: `pnpm lint && pnpm test` is a test run.
const commandKind = (command: string): VerificationKind | undefined => {
    const kinds = new Set(command.split(SEGMENTS).map(classifyCommand));
    return KINDS.map(([kind]) => kind).find((kind) => kinds.has(kind));
};

export const createVerificationLedger = (): VerificationLedger => {
    // Every edit is recorded, prose included; the prose filter is applied where it's read (`verdict`), not here.
    const edits: { path: string; at: number; prose: boolean }[] = [];
    const evidence: Evidence[] = [];
    let counter = 0;
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
            const kind = commandKind(command);
            if (kind === undefined) {
                return;
            }
            counter += 1;
            evidence.push({ kind, command: command.trim(), passed, detail: detail.slice(0, EVIDENCE_DETAIL_MAX), at: counter });
        },
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
            return failed === undefined
                ? { state: "unproven", paths, check: undefined }
                : { state: "failing", paths, check: failed.command };
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

// Commands a user would type, from the nearest project above the file; undefined means no project, empty means nothing
// recognizable there. An unmatched command reads to the model as a bug found.
export type ChecksProbe = (fromPath: string) => Promise<readonly string[] | undefined>;

const fileText = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

const nodeChecks = async (dir: string): Promise<readonly string[] | undefined> => {
    const raw = await fileText(join(dir, "package.json"));
    if (raw === undefined) {
        return undefined;
    }
    try {
        const scripts = Object.keys((JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {});
        return SUGGESTED_SCRIPTS.filter((name) => scripts.includes(name)).map((name) => `pnpm ${name}`);
    } catch {
        // A manifest that fails to parse is not this project's answer; keep walking rather than call it empty.
        return undefined;
    }
};

// Where a python config can live, most specific first; pytest.ini/tox.ini are evidence by existing alone.
const PYTHON_CONFIGS = ["pytest.ini", "tox.ini", "pyproject.toml", "setup.cfg"] as const;

// Environment's own `.venv/bin/pytest` first, since bare `pytest` is routinely off PATH; `uv run pytest` next since it
// resolves the project's own environment; the bare name is the last resort.
const pytestCommand = async (dir: string, pyproject: boolean): Promise<string> =>
    (await fileText(join(dir, ".venv", "bin", "pytest"))) === undefined ? (pyproject ? "uv run pytest" : "pytest") : ".venv/bin/pytest";

const pythonChecks = async (dir: string): Promise<readonly string[] | undefined> => {
    const found = await Promise.all(PYTHON_CONFIGS.map(async (name) => [name, await fileText(join(dir, name))] as const));
    const config = found.find(([, text]) => text !== undefined);
    if (config === undefined) {
        return undefined;
    }
    const [name, text] = config;
    const pyproject = found.some(([candidate, candidateText]) => candidate === "pyproject.toml" && candidateText !== undefined);
    const suite = name === "pytest.ini" || name === "tox.ini" || (text ?? "").includes("pytest");
    // ruff is named only where the project configures it and this image carries it: the pack may not be here.
    const lint = (text ?? "").includes("[tool.ruff") && (await onPath("ruff"));
    return [...(suite ? [await pytestCommand(dir, pyproject)] : []), ...(lint ? ["ruff check ."] : [])];
};

export const projectChecks: ChecksProbe = async (fromPath) => {
    for (let dir = dirname(resolve(fromPath)); ; ) {
        // Node first: a python project keeping a package.json is described by whichever manifest says something.
        const checks = (await nodeChecks(dir)) ?? (await pythonChecks(dir));
        if (checks !== undefined) {
            return checks;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

const nudgeText = (verdict: VerificationVerdict, commands: readonly string[]): string => {
    const paths = verdict.paths.slice(0, 8).map((path) => `- ${path}`);
    const remaining = verdict.paths.length - Math.min(verdict.paths.length, 8);
    const fileList = [...paths, ...(remaining > 0 ? [`- ... and ${remaining} more`] : [])].join("\n");
    const instruction =
        commands.length > 0
            ? `Run the check that covers it: ${commands.map((command) => `\`${command}\``).join(" or ")}, or a targeted subset of it (a single test file is fine and is often the better answer).`
            : `Nothing above this file names a check this recognises, so run whatever actually exercises the change, the project's own test binary, a targeted type-check, or a short throwaway script, and say which you chose.`;
    const failedNote =
        verdict.failed === undefined
            ? ""
            : `\n\nThe last check after those edits did NOT pass:\n\`${verdict.failed.command}\`\n${verdict.failed.detail}\nRepair that before finishing.`;
    return [
        `This turn changed code and no check has passed since the last edit:`,
        fileList,
        "",
        instruction,
        `Then state plainly what passed and what it covered: do not report a targeted check as the suite being green.${failedNote}`,
    ].join("\n");
};

// verify-edits, as one function rather than a rule: it compares what the turn edited against what it proved, which only
// the daemon can see live. Undefined means nothing to ask for, the common case, at no cost.
export const verifyEditsMessage = async (
    ledger: VerificationLedger,
    isolation?: IsolationPlan,
    checks: ChecksProbe = projectChecks,
): Promise<string | undefined> => {
    const verdict = ledger.verdict();
    if (verdict === undefined) {
        return undefined;
    }
    // The paths the agent named are read back; the probe needs the daemon's view, which differs when isolated.
    const first = verdict.paths[0];
    const defined = first === undefined ? undefined : await checks(inWorktree(first, isolation));
    return nudgeText(verdict, defined ?? []);
};
