import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { inWorktree, type IsolationPlan } from "../agents/isolation.js";

/* DID THIS TURN PROVE ANYTHING? — the one question a turn that edited code should not end without answering,
 * and the one nothing in the daemon was asking.
 *
 * Post-edit diagnostics (agent-diagnostics.ts) already answer a NARROWER question, per edit: does this file
 * still type-check. That catches the broken import and the renamed field, and it catches them early enough to
 * be free. What it cannot catch is the whole class of change that compiles perfectly and does the wrong thing
 * — which is most of them. The suite is what catches those, and whether the suite ran is not a property of any
 * single edit, so no per-edit hook can see it.
 *
 * So this is a LEDGER over the turn rather than a check on a file. Two facts go in — which code files this turn
 * changed, and which commands it ran that constitute evidence — and one question comes out at the end: is
 * there a passing check that ran AFTER the last edit. If there is, the turn ends silently and has cost
 * nothing. If there is not, the model is handed one bounded follow-up naming the commands this workspace
 * actually has, and the turn continues instead of ending on unverified work.
 *
 * ORDER IS THE WHOLE POINT, which is why edits and evidence share one counter rather than each keeping their
 * own timestamps. `pnpm test` then three edits is a turn with no evidence for those edits, and it reads as
 * verified under any scheme that only asks "did a test run this turn". The counter makes "after" mean after.
 *
 * PER-TURN AND IN MEMORY, deliberately. Evidence from an earlier turn says nothing about edits made in this
 * one, so there is nothing to persist and no store to age out — the ledger is born with the hooks and dies
 * with them. hermes-agent keeps the equivalent in SQLite keyed by session + workspace root with 30-day
 * retention, which it needs because its ledger also answers cross-session questions; ours does not.
 *
 * WHAT IT WILL NOT DO. It never runs a command itself — it reads what the agent already ran and decides
 * whether to ask for one more. It never upgrades a targeted check into "the repo is green": a passing
 * `vitest run src/foo.test.ts` clears the nudge because it IS evidence about the change, and claiming more
 * than that is the failure mode this whole mechanism exists to prevent. And it never nudges on prose — a turn
 * that touched only markdown has nothing a test could speak to.
 *
 * Off by default (`verifyOnStop`), like every other steer that spends tokens on the user's behalf: this one
 * costs a whole extra model turn when it fires, and whether that trade pays depends on a workspace whose
 * canonical checks it cannot know in advance. */

// Extensions whose edits no suite can speak to. A turn that touched ONLY these is done when it says it is.
// Everything not listed is treated as code — the safe direction, since the cost of a false negative here is a
// silent unverified change and the cost of a false positive is one skipped nudge.
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log"]);

// Prose even without a prose extension.
const PROSE_FILENAMES = new Set(["license", "licence", "notice", "authors", "contributors", "changelog", "codeowners"]);

// At most this many follow-ups per turn. The model gets a second ask only because the first one is sometimes
// answered with a check that fails — one more round to repair it is the point. A third would be a loop.
const MAX_NUDGES = 2;

// How much of a failing check's own words ride back with the nudge. Enough to act on, not enough to re-paste a
// suite: the output is still in the transcript directly above.
const EVIDENCE_DETAIL_MAX = 800;

// Scripts worth suggesting, most-load-bearing first — a name is offered only if the workspace actually defines
// it, so this is a preference order over what exists rather than a guess at what should.
const SUGGESTED_SCRIPTS = ["test", "typecheck", "check", "lint", "build"] as const;

export type VerificationKind = "test" | "typecheck" | "lint" | "build";

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
    // The last check that ran after the final edit and did NOT pass, when there was one — the difference
    // between "you never checked" and "you checked and it broke", which want different follow-ups.
    readonly failed: Evidence | undefined;
}

export interface VerificationLedger {
    readonly noteEdit: (path: string) => void;
    readonly noteCommand: (command: string, passed: boolean, detail: string) => void;
    // Undefined ⇒ nothing to ask for: no code was edited, or a passing check followed the last edit.
    readonly verdict: () => VerificationVerdict | undefined;
}

const isProsePath = (path: string): boolean => {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    return PROSE_EXTENSIONS.has(extname(name)) || PROSE_FILENAMES.has(name.replace(extname(name), ""));
};

// Shell separators that start a new command. Everything between them is classified on its own, so
// `cd x && pnpm test` is recognised by its second segment.
const SEGMENTS = /(?:&&|\|\||;|\|)/;

// Wrappers and prefixes that stand in front of the command that matters. Dropped so the token after them is
// what gets classified — `pnpm -C _libs/foo test` classifies on `test`, not on `pnpm`.
const RUNNERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx", "run", "exec", "time", "sudo", "env"]);

// Flags that take a value, so the value is not mistaken for the command (`pnpm -C dir test`).
const VALUED_FLAGS = new Set(["-C", "--dir", "--filter", "-w", "--workspace"]);

// What a bare token proves. Matched on the binary's basename, so `./node_modules/.bin/vitest` and `vitest` are
// the same fact. Deliberately not exhaustive — an unrecognised command is simply not evidence, which costs one
// nudge the agent can satisfy by naming a check this table knows.
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
    const tokens = segment.trim().split(/\s+/).filter((token) => token !== "");
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
            // The next non-flag token is the subcommand — `cargo test`, `go build`.
            const next = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
            return next === undefined ? undefined : kindOf(basename(next));
        }
        return kindOf(token);
    }
    return undefined;
};

const kindOf = (token: string): VerificationKind | undefined => KINDS.find(([, names]) => names.has(token))?.[0];

// A command proves the STRONGEST thing any of its segments proves: `pnpm lint && pnpm test` is a test run.
const commandKind = (command: string): VerificationKind | undefined => {
    const kinds = new Set(command.split(SEGMENTS).map(classifyCommand));
    return KINDS.map(([kind]) => kind).find((kind) => kinds.has(kind));
};

export const createVerificationLedger = (): VerificationLedger => {
    const edits: { path: string; at: number }[] = [];
    const evidence: Evidence[] = [];
    let counter = 0;
    return {
        noteEdit: (path) => {
            if (isProsePath(path)) {
                return;
            }
            counter += 1;
            edits.push({ path, at: counter });
        },
        noteCommand: (command, passed, detail) => {
            const kind = commandKind(command);
            if (kind === undefined) {
                return;
            }
            counter += 1;
            evidence.push({ kind, command: command.trim(), passed, detail: detail.slice(0, EVIDENCE_DETAIL_MAX), at: counter });
        },
        verdict: () => {
            const lastEdit = edits.at(-1);
            if (lastEdit === undefined) {
                return undefined;
            }
            const after = evidence.filter((item) => item.at > lastEdit.at);
            if (after.some((item) => item.passed)) {
                return undefined;
            }
            // Newest-last, deduped: the same file edited five times is one path to name.
            const paths = [...new Set(edits.map((edit) => edit.path))];
            const failed = after.findLast((item) => !item.passed);
            return { paths, ...(failed !== undefined ? { failed } : { failed: undefined }) };
        },
    };
};

// The scripts this workspace actually defines, nearest package.json wins. Injectable so the hook's tests need
// no fixture tree. Undefined ⇒ no package.json above the file, which is a real answer: the nudge then asks for
// a check without naming one rather than inventing `pnpm test` for a workspace that has no such script.
export type ScriptsProbe = (fromPath: string) => Promise<readonly string[] | undefined>;

const readPackageScripts: ScriptsProbe = async (fromPath) => {
    for (let dir = dirname(resolve(fromPath)); ; ) {
        try {
            const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
            return Object.keys(raw.scripts ?? {});
        } catch {
            const parent = dirname(dir);
            if (parent === dir) {
                return undefined;
            }
            dir = parent;
        }
    }
};

// What to tell the agent to run: the defined scripts we know are checks, in preference order, as the command a
// user would type. Empty ⇒ nothing recognisable, and the nudge says so instead of naming a script that would
// exit "command not found" and read as the check finding a bug.
const suggestedCommands = (scripts: readonly string[]): string[] =>
    SUGGESTED_SCRIPTS.filter((name) => scripts.includes(name)).map((name) => `pnpm ${name}`);

const nudgeText = (verdict: VerificationVerdict, commands: readonly string[]): string => {
    const paths = verdict.paths.slice(0, 8).map((path) => `- ${path}`);
    const remaining = verdict.paths.length - Math.min(verdict.paths.length, 8);
    const fileList = [...paths, ...(remaining > 0 ? [`- ... and ${remaining} more`] : [])].join("\n");
    const instruction =
        commands.length > 0
            ? `Run the check that covers it — ${commands.map((command) => `\`${command}\``).join(" or ")} — or a targeted subset of it (a single test file is fine and is often the better answer).`
            : `This workspace defines no test/lint/typecheck script, so run whatever actually exercises the change — the package's own test binary, a targeted type-check, or a short throwaway script — and say which you chose.`;
    const failedNote =
        verdict.failed === undefined
            ? ""
            : `\n\nThe last check after those edits did NOT pass:\n\`${verdict.failed.command}\`\n${verdict.failed.detail}\nRepair that before finishing.`;
    return [
        `This turn changed code and no check has passed since the last edit:`,
        fileList,
        "",
        instruction,
        `Then state plainly what passed and what it covered — do not report a targeted check as the suite being green.${failedNote}`,
    ].join("\n");
};

// Does this Bash result say the command failed? The tmux wrapper's footer carries the real exit code
// (`--- [exit 7, 2s] ...`), which is the authoritative answer whenever output filtering is on. Without a
// footer there is nothing to read here and the caller's event tells us instead: PostToolUse ⇒ ran,
// PostToolUseFailure ⇒ did not.
const footerExitCode = (response: unknown): number | undefined => {
    const text = typeof response === "string" ? response : typeof response === "object" && response !== null ? JSON.stringify(response) : "";
    const matches = [...text.matchAll(/---\s\[exit\s(\d+),/g)];
    const last = matches.at(-1)?.[1];
    return last === undefined ? undefined : Number(last);
};

const bashCommand = (input: unknown): string | undefined => {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

const editedPath = (input: unknown): string | undefined => {
    const path = (input as { file_path?: unknown }).file_path;
    return typeof path === "string" && path !== "" ? path : undefined;
};

/* The hooks. Edits and Bash results feed the ledger; Stop reads it once the turn tries to end.
 *
 * `stop_hook_active` is the SDK's own re-entry flag — true when this Stop is the one that follows a hook that
 * already continued the turn. We count our own asks anyway (a turn can be stopped for other reasons in
 * between) and honour both, so neither alone can produce a loop. */
export const verificationHooks = (
    isolation?: IsolationPlan,
    scripts: ScriptsProbe = readPackageScripts,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const ledger = createVerificationLedger();
    let nudges = 0;
    return {
        PostToolUse: [
            {
                matcher: "Edit|Write|NotebookEdit",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PostToolUse") {
                            const path = editedPath(input.tool_input);
                            if (path !== undefined) {
                                ledger.noteEdit(path);
                            }
                        }
                        return {};
                    },
                ],
            },
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const command = bashCommand(input.tool_input);
                        if (command !== undefined) {
                            const exit = footerExitCode(input.tool_response);
                            const text = typeof input.tool_response === "string" ? input.tool_response : "";
                            ledger.noteCommand(command, exit === undefined || exit === 0, text);
                        }
                        return {};
                    },
                ],
            },
        ],
        PostToolUseFailure: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUseFailure") {
                            return {};
                        }
                        const command = bashCommand(input.tool_input);
                        if (command !== undefined) {
                            ledger.noteCommand(command, false, input.error);
                        }
                        return {};
                    },
                ],
            },
        ],
        Stop: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "Stop" || input.stop_hook_active || nudges >= MAX_NUDGES) {
                            return {};
                        }
                        const verdict = ledger.verdict();
                        if (verdict === undefined) {
                            return {};
                        }
                        nudges += 1;
                        // The paths the agent named are the ones it reads back; the probe needs the daemon's
                        // view of them, which under an unanchored isolated turn is a different file.
                        const first = verdict.paths[0];
                        const defined = first === undefined ? undefined : await scripts(inWorktree(first, isolation));
                        return {
                            hookSpecificOutput: {
                                hookEventName: "Stop",
                                additionalContext: nudgeText(verdict, suggestedCommands(defined ?? [])),
                            },
                        };
                    },
                ],
            },
        ],
    };
};
