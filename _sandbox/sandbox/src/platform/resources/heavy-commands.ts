import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";
import type { ManifestProblem } from "../../store/manifest-problems.js";
import { heredocSpans } from "../../heredoc.js";

// Which agent commands are too big to run four at once, as an editable list: a monorepo fan-out exhausts memory, which
// no scheduling class rations, and the admission gate can't see a command a running turn spawns. Enforced at the
// PreToolUse hook every Bash call passes through; not a security boundary, it only stops the accident.

// Characters of the command a rule's regex runs against; bounds backtracking since node has no regex timeout.
export const MATCH_LIMIT = 4096;

// What a queued command does once `waitSeconds` passes with every slot still held: `run` starts it anyway, `skip`
// exits QUEUE_SKIPPED_EXIT_CODE having run nothing, for a command whose overlap with a holder is the incident itself.
export const OnDeadlineSchema = z.enum(["run", "skip"]);

export type OnDeadline = z.infer<typeof OnDeadlineSchema>;

// queue-run's exit for a command it skipped: EX_TEMPFAIL, so a caller records "not measured", never "failed".
export const QUEUE_SKIPPED_EXIT_CODE = 75;

export const HeavyCommandRuleSchema = z.object({
    // Names the rule in logs and the pane's "waiting" line; free text, duplicates allowed.
    id: z.string().min(1),
    // JS regex source (no delimiters/flags), case-insensitive; a pattern that fails to compile is reported, not fatal.
    pattern: z.string().min(1),
    // Which slot pool this rule draws from; rules sharing a pool contend, defaults to `defaultPool`.
    pool: z.string().min(1).optional(),
    // Slots in this rule's pool when it differs from the file's `limit`; the first matching rule decides both.
    limit: z.number().int().positive().optional(),
    // Seconds this rule's commands may hold a slot when that differs from the file's; 0 means never killed.
    maxHoldSeconds: z.number().int().nonnegative().optional(),
    // Matching this rule means the command is explicitly not queued: an exception written above the rule it escapes.
    exempt: z.boolean().optional(),
    // This rule's answer at the deadline when it differs from the file's.
    onDeadline: OnDeadlineSchema.optional(),
});

export type HeavyCommandRule = z.infer<typeof HeavyCommandRuleSchema>;

export const HeavyCommandsSchema = z.object({
    // How many matching commands may run at once across the sandbox; two fits twice the peak of one bounded run.
    limit: z.number().int().positive().default(2),
    // Pool for rules that name none.
    defaultPool: z.string().min(1).default("heavy"),
    // How long a command waits for a slot before running anyway, so a stuck queue can't turn into a dead sandbox.
    waitSeconds: z.number().int().nonnegative().default(900),
    // Whether a matching command also waits for memory headroom, and for how long.
    memoryGateSeconds: z.number().int().nonnegative().default(120),
    // How long a command may HOLD a slot before it is killed, which `waitSeconds` (queueing for one) does not
    // bound. Generous on purpose: this exists to end a hang, not to cap honest work, and a batch command still
    // running after half an hour on this box is already the anomaly. 0 switches the ceiling off.
    maxHoldSeconds: z.number().int().nonnegative().default(1800),
    // `run` for rules that say nothing: for a person's command the wrapper must never be the reason it did not run.
    onDeadline: OnDeadlineSchema.default("run"),
    // Matched in file order, first match wins; an empty list switches the queue off entirely.
    rules: z.array(HeavyCommandRuleSchema).default([]),
});

export type HeavyCommands = z.infer<typeof HeavyCommandsSchema>;

// The shipped list: every entry is something measured pinning this box, not merely slow, matched loosely on spelling
// and strictly on verb.
export const DEFAULT_HEAVY_COMMANDS: HeavyCommands = HeavyCommandsSchema.parse({
    rules: [
        // Reading about a build is not running one; anchored so it exempts a search, not a line containing one.
        {
            id: "read-only",
            pattern: "^\\s*(grep|rg|iq|ag|cat|bat|head|tail|less|ls|find|fd|wc|which|echo|git\\s+(log|status|diff|show|blame))\\b",
            exempt: true,
        },
        // A watch or a server is meant to outlive its command, so it can neither take turns nor be killed for
        // holding a slot: queueing one means holding a slot until the user stops it, which is the leak the
        // ceiling below exists to stop, arriving as intended behaviour. Above the rules it escapes.
        {
            id: "long-lived",
            // `--watch` without a trailing boundary so `--watchAll` and `--watch=true` come too; `-w` is NOT here,
            // because `pnpm -w test` is a workspace-root fan-out and exempting it would free the heaviest command.
            pattern: "--watch|\\bnodemon\\b|\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?(dev|serve|start)\\b",
            exempt: true,
        },
        // A repo-wide verification, given a limit of ONE while staying in the same pool: two of them are the most
        // expensive thing that can happen to this box at once (measured: 4m17s and ~6000 tests apiece, racing for
        // the same two slots and making an unrelated unit test wait 96s), and the second is usually the same work
        // over the same tree. Serialised they are not merely politer — turbo's cache has been written by the time
        // the second starts, so in one worktree it costs almost nothing. Keeping the pool means this does not raise
        // the number of heavy commands the box runs; it only stops two of these being them.
        // Never two at once, not even after the wait: overlapping is the measured peak (24.9 GiB against a 16 GiB cap),
        // and a verification that did not run costs a check the next land repeats.
        { id: "repo-verify", pattern: "\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b", limit: 1, onDeadline: "skip" },
        // A program's name joined to `.` or `-` is part of a file name or another word (a `vitest.config` file, a
        // `check-tsc` script), not the program.
        { id: "vitest", pattern: "(?<![-.])\\bvitest\\b(?![-.])" },
        { id: "typechecker", pattern: "(?<![-.])\\b(tsc|tsgo|vue-tsc)\\b(?![-.])" },
        { id: "turbo-fanout", pattern: "\\bturbo\\b[^&|;]*\\brun\\b[^&|;]*\\b(build|test|typecheck|check)\\b" },
        { id: "package-script", pattern: "\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b" },
    ],
});

// A rule with its pattern compiled, or nothing if it doesn't. Case-insensitive and uncheckpointed, since a rule describes a
// command that appears in the line, not the whole line.
const compile = (rule: HeavyCommandRule, report?: (problem: ManifestProblem) => void): { rule: HeavyCommandRule; regex: RegExp } | undefined => {
    try {
        return { rule, regex: new RegExp(rule.pattern, "i") };
    } catch (error) {
        report?.({ kind: "invalidEntry", detail: `${rule.id}: ${error instanceof Error ? error.message : "bad pattern"}` });
        return undefined;
    }
};

export interface HeavyMatch {
    // The rule that matched, for the log line and the pane's "waiting" notice.
    readonly id: string;
    readonly pool: string;
    readonly limit: number;
    // Seconds before the slot is taken back by force; 0 means this command is never killed for holding one.
    readonly maxHold: number;
    readonly onDeadline: OnDeadline;
}

// Splits a compound line into the commands it runs. Still not a shell parser — it knows quotes and backslashes and
// nothing else, so a subshell's contents stay part of the segment that spawns it, which over-matches the safe way.
//
// QUOTES ARE THE WHOLE POINT. Splitting on raw separators tore an awk or grep PROGRAM into fragments and then matched
// the rules against those: measured, `ps -eo … | awk '… if (cmd ~ /vitest/) role="vitest" …' | sort` became thirteen
// pieces, one of them `else if (cmd ~ /vitest/) role="vitest"`, and a read-only listing waited in the heavy pool for a
// slot it had no business wanting. A separator that really separates two commands is never inside quotes, so honouring
// them costs no detection at all: `bash -c "pnpm test"` stays one segment and still matches on `pnpm … test`.
const SEPARATOR_HEADS = new Set([";", "&", "|", "\n"]);

// The quote run we are inside after reading `char`, or "" for outside one. A run ends only on its own quote character,
// which is what keeps a `"` inside '…' from closing anything.
const quoteAfter = (quote: string, char: string): string => {
    if (quote !== "") {
        return char === quote ? "" : quote;
    }
    return char === "'" || char === '"' ? char : "";
};

export const commandSegments = (command: string): string[] => {
    const segments: string[] = [];
    let current = "";
    // An unbalanced quote simply runs to the end of the line, which keeps the tail whole rather than splitting it.
    let quote = "";
    for (let i = 0; i < command.length; i++) {
        const char = command[i] as string;
        // Outside single quotes a backslash protects the next character, separator or not; both stay in this segment.
        if (char === "\\" && quote !== "'") {
            current += char + (command[i + 1] ?? "");
            i += 1;
            continue;
        }
        if (quote === "" && SEPARATOR_HEADS.has(char)) {
            segments.push(current);
            current = "";
            // `&&` and `||` are one separator, not two; the second character must not open an empty segment.
            if (command[i + 1] === char) {
                i += 1;
            }
            continue;
        }
        quote = quoteAfter(quote, char);
        current += char;
    }
    segments.push(current);
    return segments.filter((segment) => segment.trim() !== "");
};

// Shells whose quoted argument IS a command line rather than data, so the rules must keep reading inside it.
const SHELLS = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\b/u;

// Quoted runs, single or double, including an unterminated one at the end of the line.
const QUOTED = /'[^']*'?|"(?:\\.|[^"\\])*"?/gu;

// A word carrying a glob metacharacter, blanked whole. `[` and `]` are in the class so a bracket expression goes too.
const GLOB_WORD = /\S*[*?[\]]\S*/gu;

// `#` to the end of the segment, once the quotes are already gone so a `#` inside one cannot start a comment.
const COMMENT = /(^|\s)#.*$/u;

// A `NAME=value` word: shell-identifier name, so `--filter=x` is not one. Anchored at a word start, and the leading
// space is put back by the replacement.
const ASSIGNMENT_WORD = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=\S*/gu;

// What a segment's rules are actually matched against: the command, with everything that cannot BE a command blanked.
//
// Three kinds of text name a heavy tool without running one, and each was measured queueing something read-only:
//   - a quoted run is data — `ps … | awk '… /vitest/ …' | sort` waited behind two repo-wide test runs, and
//     `git commit -m "add a test"` queued a commit;
//   - a glob is a pattern, not a program — a `case` label `*vue-tsc*` in a shell loop that only read /proc held the
//     `typechecker` slot for 18 seconds, which is what put this line here;
//   - a comment is a note to a person;
//   - a `NAME=value` word is a variable, and `k=vitest` in the same loop matched on the `\b` that `=` provides.
// Blanking them can cost no detection, because no rule matches a pattern, a comment or an assignment: every rule names
// a program and a verb, and the one assignment that precedes real work — `VITEST_MAX_WORKERS=4 turbo run test` — is
// still judged on the `turbo run test` it leaves behind. The exception is a shell: `bash -c "pnpm test"` really does
// run what it quotes, so for those the text stays whole and over-matches the safe way.
const matchableText = (segment: string): string =>
    SHELLS.test(segment) ? segment : segment.replace(QUOTED, " ").replace(COMMENT, " ").replace(GLOB_WORD, " ").replace(ASSIGNMENT_WORD, " ");

// A heredoc's body is stdin for the command that opens it (`cat > f`, `python3 -`), so its lines are data; only a shell
// reading one runs it, and that body stays. Later spans are cut first so earlier offsets still hold.
const withoutHeredocBodies = (command: string): string =>
    heredocSpans(command)
        .toReversed()
        .reduce((text, span) => {
            const openingLine = text.slice(text.lastIndexOf("\n", span.start - 1) + 1, span.start);
            const opener = openingLine.slice(0, openingLine.indexOf("<<")).split(/[;&|(]/u).at(-1) ?? "";
            return SHELLS.test(opener) ? text : text.slice(0, span.start) + text.slice(span.end);
        }, command);

// Whether this command is one of the big ones, as a pure function of the line and config, matched against the agent's
// own command before the daemon's wrapping and before secret resolution.
export const matchHeavyCommand = (command: string, config: HeavyCommands, report?: (problem: ManifestProblem) => void): HeavyMatch | undefined => {
    // Compiled once per line, not per segment, so a bad pattern isn't reported once per segment of one Bash call.
    const compiled = config.rules.flatMap((rule) => {
        const one = compile(rule, report);
        return one === undefined ? [] : [one];
    });
    for (const segment of commandSegments(withoutHeredocBodies(command.slice(0, MATCH_LIMIT))).map(matchableText)) {
        for (const { rule, regex } of compiled) {
            if (!regex.test(segment)) {
                continue;
            }
            // First match decides this segment; an exemption can stop the search before a broader rule's turn.
            if (rule.exempt === true) {
                break;
            }
            return {
                id: rule.id,
                pool: rule.pool ?? config.defaultPool,
                limit: rule.limit ?? config.limit,
                maxHold: rule.maxHoldSeconds ?? config.maxHoldSeconds,
                onDeadline: rule.onDeadline ?? config.onDeadline,
            };
        }
    }
    return undefined;
};

export interface HeavyCommandsStore {
    // The file's rules, or the shipped defaults when absent, unreadable, or invalid.
    readonly read: () => Promise<HeavyCommands>;
    // Writes the defaults only if the file doesn't exist yet, so a hand-tuned file is never touched.
    readonly seed: () => Promise<void>;
}

export const fileHeavyCommandsStore = (path: string, onInvalid?: (detail: string) => void): HeavyCommandsStore => {
    const file = jsonFile<HeavyCommands | undefined>(path, {
        parse: (raw, report) => {
            const parsed = HeavyCommandsSchema.safeParse(raw);
            if (parsed.success) {
                // Compiling here, not only at match time, surfaces a bad pattern where the rule vanished from.
                for (const rule of parsed.data.rules) {
                    compile(rule, report);
                }
                return parsed.data;
            }
            onInvalid?.(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            return undefined;
        },
        // `undefined` marks no usable file, unlike one that parsed, so `seed` writes only when there's nothing to lose.
        fallback: () => undefined,
    });
    return {
        read: async () => (await file.read()) ?? DEFAULT_HEAVY_COMMANDS,
        seed: async () => {
            await file.update((current) => current ?? DEFAULT_HEAVY_COMMANDS);
        },
    };
};
