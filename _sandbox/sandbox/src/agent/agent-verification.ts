import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { inWorktree, type IsolationPlan } from "../agents/isolation.js";

/* DID THIS TURN PROVE ANYTHING?, the one question a turn that edited code should not end without answering,
 * and the one nothing in the daemon was asking.
 *
 * Post-edit diagnostics (agent-diagnostics.ts) already answer a NARROWER question, per edit: does this file
 * still type-check. That catches the broken import and the renamed field, and it catches them early enough to
 * be free. What it cannot catch is the whole class of change that compiles perfectly and does the wrong thing
 *, which is most of them. The suite is what catches those, and whether the suite ran is not a property of any
 * single edit, so no per-edit hook can see it.
 *
 * So this is a LEDGER over the turn rather than a check on a file. Two facts go in, which code files this turn
 * changed, and which commands it ran that constitute evidence, and one question comes out at the end: is
 * there a passing check that ran AFTER the last edit. If there is, the turn ends silently and has cost
 * nothing. If there is not, the model is handed one bounded follow-up naming the commands this workspace
 * actually has, and the turn continues instead of ending on unverified work.
 *
 * ORDER IS THE WHOLE POINT, which is why edits and evidence share one counter rather than each keeping their
 * own timestamps. `pnpm test` then three edits is a turn with no evidence for those edits, and it reads as
 * verified under any scheme that only asks "did a test run this turn". The counter makes "after" mean after.
 *
 * PER-TURN AND IN MEMORY, deliberately. Evidence from an earlier turn says nothing about edits made in this
 * one, so there is nothing to persist and no store to age out, the ledger is born with the hooks and dies
 * with them. hermes-agent keeps the equivalent in SQLite keyed by session + workspace root with 30-day
 * retention, which it needs because its ledger also answers cross-session questions; ours does not.
 *
 * WHAT IT WILL NOT DO. It never runs a command itself, it reads what the agent already ran and decides
 * whether to ask for one more. It never upgrades a targeted check into "the repo is green": a passing
 * `vitest run src/foo.test.ts` clears the nudge because it IS evidence about the change, and claiming more
 * than that is the failure mode this whole mechanism exists to prevent. And it never nudges on prose, a turn
 * that touched only markdown has nothing a test could speak to.
 *
 * Off by default (`verifyOnStop`), like every other steer that spends tokens on the user's behalf: this one
 * costs a whole extra model turn when it fires, and whether that trade pays depends on a workspace whose
 * canonical checks it cannot know in advance. */

// Extensions whose edits no suite can speak to. A turn that touched ONLY these is done when it says it is.
// Everything not listed is treated as code, the safe direction, since the cost of a false negative here is a
// silent unverified change and the cost of a false positive is one skipped nudge.
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log"]);

// Prose even without a prose extension.
const PROSE_FILENAMES = new Set(["license", "licence", "notice", "authors", "contributors", "changelog", "codeowners"]);

// How much of a failing check's own words ride back with the nudge. Enough to act on, not enough to re-paste a
// suite: the output is still in the transcript directly above.
const EVIDENCE_DETAIL_MAX = 800;

// Scripts worth suggesting, most important first. A name is offered only if the workspace actually defines
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
    // The last check that ran after the final edit and did NOT pass, when there was one, the difference
    // between "you never checked" and "you checked and it broke", which want different follow-ups.
    readonly failed: Evidence | undefined;
}

export interface VerificationLedger {
    readonly noteEdit: (path: string) => void;
    readonly noteCommand: (command: string, passed: boolean, detail: string) => void;
    // Undefined ⇒ nothing to ask for: no code was edited, or a passing check followed the last edit.
    readonly verdict: () => VerificationVerdict | undefined;
    /* Every code path this turn edited, deduped, newest last, whether or not anything has since proven them.
     * `verdict` cannot answer this: it goes quiet precisely when the work WAS verified, and a rule that reads
     * "before a turn ending that touched the database" has to fire on a turn that did its job properly. So the
     * ledger is two readers over one record, what still wants proof, and what was touched at all. */
    readonly edited: () => readonly string[];
}

const isProsePath = (path: string): boolean => {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    return PROSE_EXTENSIONS.has(extname(name)) || PROSE_FILENAMES.has(name.replace(extname(name), ""));
};

// Shell separators that start a new command. Everything between them is classified on its own, so
// `cd x && pnpm test` is recognised by its second segment.
const SEGMENTS = /(?:&&|\|\||;|\|)/;

// Wrappers and prefixes that stand in front of the command that matters. Dropped so the token after them is
// what gets classified, `pnpm -C _libs/foo test` classifies on `test`, not on `pnpm`.
const RUNNERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx", "run", "exec", "time", "sudo", "env"]);

// Flags that take a value, so the value is not mistaken for the command (`pnpm -C dir test`).
const VALUED_FLAGS = new Set(["-C", "--dir", "--filter", "-w", "--workspace"]);

// What a bare token proves. Matched on the binary's basename, so `./node_modules/.bin/vitest` and `vitest` are
// the same fact. Deliberately not exhaustive, an unrecognised command is simply not evidence, which costs one
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

// A command proves the STRONGEST thing any of its segments proves: `pnpm lint && pnpm test` is a test run.
const commandKind = (command: string): VerificationKind | undefined => {
    const kinds = new Set(command.split(SEGMENTS).map(classifyCommand));
    return KINDS.map(([kind]) => kind).find((kind) => kinds.has(kind));
};

export const createVerificationLedger = (): VerificationLedger => {
    /* EVERY edit is recorded, prose included, and the prose filter is applied by `verdict` where it belongs.
     *
     * It used to be applied here, at the door, and that was right while asking for proof was the only thing
     * reading this record. It stopped being right the moment rule conditions started reading it too: "before a
     * turn that touched docs/**, remind me to check the docs build" is a perfectly reasonable rule, and a
     * ledger that had already discarded the docs edit could never fire it. Filtering at the reader keeps both
     * honest, nothing asks for proof of a README, and nothing pretends the README was never written. */
    const edits: { path: string; at: number; prose: boolean }[] = [];
    const evidence: Evidence[] = [];
    let counter = 0;
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
            // Only code counts here, a turn that touched nothing else is done when it says it is, and the
            // ORDER question ("did a check run after the last edit") is about the last edit a check could
            // speak to, not the last edit of any kind.
            const code = edits.filter((edit) => !edit.prose);
            const lastEdit = code.at(-1);
            if (lastEdit === undefined) {
                return undefined;
            }
            const after = evidence.filter((item) => item.at > lastEdit.at);
            if (after.some((item) => item.passed)) {
                return undefined;
            }
            // Newest-last, deduped: the same file edited five times is one path to name.
            const paths = [...new Set(code.map((edit) => edit.path))];
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
    for (let dir = dirname(resolve(fromPath)); ;) {
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

/* THE `verify-edits` BUILT-IN, as one function: what this turn should be told, or nothing.
 *
 * A built-in action rather than something the rule table could express, because what it does is not a command
 * and never will be, it reads a running record of what the turn edited against what the turn proved, and only
 * the daemon is standing where both of those are visible. The rule table's job is to say WHEN it applies and
 * under what conditions; this is the part that would be absurd to ask an owner to write.
 *
 * Undefined ⇒ nothing to ask for, which is the common case and costs the turn nothing. */
export const verifyEditsMessage = async (
    ledger: VerificationLedger,
    isolation?: IsolationPlan,
    scripts: ScriptsProbe = readPackageScripts,
): Promise<string | undefined> => {
    const verdict = ledger.verdict();
    if (verdict === undefined) {
        return undefined;
    }
    // The paths the agent named are the ones it reads back; the probe needs the daemon's view of them, which
    // under an unanchored isolated turn is a different file.
    const first = verdict.paths[0];
    const defined = first === undefined ? undefined : await scripts(inWorktree(first, isolation));
    return nudgeText(verdict, suggestedCommands(defined ?? []));
};
