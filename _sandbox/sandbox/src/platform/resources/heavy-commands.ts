import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";
import type { ManifestProblem } from "../../store/manifest-problems.js";

// Which agent commands are too big to run four at once, as an editable list: a monorepo fan-out exhausts memory, which
// no scheduling class rations, and the admission gate can't see a command a running turn spawns. Enforced at the
// PreToolUse hook every Bash call passes through; not a security boundary, it only stops the accident.

// Characters of the command a rule's regex runs against; bounds backtracking since node has no regex timeout.
export const MATCH_LIMIT = 4096;

export const HeavyCommandRuleSchema = z.object({
    // Names the rule in logs and the pane's "waiting" line; free text, duplicates allowed.
    id: z.string().min(1),
    // JS regex source (no delimiters/flags), case-insensitive; a pattern that fails to compile is reported, not fatal.
    pattern: z.string().min(1),
    // Which slot pool this rule draws from; rules sharing a pool contend, defaults to `defaultPool`.
    pool: z.string().min(1).optional(),
    // Slots in this rule's pool when it differs from the file's `limit`; the first matching rule decides both.
    limit: z.number().int().positive().optional(),
    // Matching this rule means the command is explicitly not queued: an exception written above the rule it escapes.
    exempt: z.boolean().optional(),
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
        { id: "vitest", pattern: "\\bvitest\\b" },
        { id: "typechecker", pattern: "\\b(tsc|tsgo|vue-tsc)\\b" },
        { id: "turbo-fanout", pattern: "\\bturbo\\b[^&|;]*\\brun\\b[^&|;]*\\b(build|test|typecheck|check)\\b" },
        { id: "package-script", pattern: "\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b" },
    ],
});

// A rule with its pattern compiled, or nothing if it doesn't. Case-insensitive and unanchored, since a rule describes a
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
}

// Splits a compound line into the commands it runs; not a shell parser, so a quoted separator over-matches on purpose.
const SEPARATORS = /&&|\|\||[;&|\n]/u;

export const commandSegments = (command: string): string[] => command.split(SEPARATORS).filter((segment) => segment.trim() !== "");

// Whether this command is one of the big ones, as a pure function of the line and config, matched against the agent's
// own command before the daemon's wrapping and before secret resolution.
export const matchHeavyCommand = (command: string, config: HeavyCommands, report?: (problem: ManifestProblem) => void): HeavyMatch | undefined => {
    // Compiled once per line, not per segment, so a bad pattern isn't reported once per segment of one Bash call.
    const compiled = config.rules.flatMap((rule) => {
        const one = compile(rule, report);
        return one === undefined ? [] : [one];
    });
    for (const segment of commandSegments(command.slice(0, MATCH_LIMIT))) {
        for (const { rule, regex } of compiled) {
            if (!regex.test(segment)) {
                continue;
            }
            // First match decides this segment; an exemption can stop the search before a broader rule's turn.
            if (rule.exempt === true) {
                break;
            }
            return { id: rule.id, pool: rule.pool ?? config.defaultPool, limit: rule.limit ?? config.limit };
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
