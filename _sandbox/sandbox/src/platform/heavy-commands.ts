import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import type { ManifestProblem } from "../store/manifest-problems.js";

/* WHICH AGENT COMMANDS ARE TOO BIG TO RUN FOUR AT A TIME, as an editable list rather than a constant.
 *
 * The demotion in agent-terminals.ts (POLITE_PREFIX, nice +10 / ionice best-effort 7) was the first answer to
 * this and it is the wrong tool by itself: priorities arbitrate CPU, and what a monorepo fan-out exhausts is
 * MEMORY, which no scheduler class rations. Measured on this sandbox, 2026-08-25 09:07-09:29, with the cgroup
 * already at its final 16 GiB cap: the `other` process role went from ~60 processes holding 4.5 GiB to 204
 * holding 15.0 GiB, memory.current pinned at 16.00 GiB, memory PSI `full` hit 88.3%, load1 reached 312 on 16
 * cores, and the daemon's own event loop stalled for 615 seconds. The resource sampler missed twelve
 * consecutive minutes (09:09 -> 09:21) because it could not get scheduled to write a line. Every session on the
 * box was frozen for the duration, and nothing had crashed: swap is unbounded here (`--memory-swap -1`, see
 * @intentic/sandbox-run), so the box does not die, it GRINDS.
 *
 * ONE INVOCATION IS ALREADY BOUNDED; the box is not. turbo's `concurrency: 4` and VITEST_MAX_WORKERS=4 both
 * bound a SINGLE `pnpm test`, and four agents running one each are four independent turbo processes that have
 * never heard of one another. The admission gate cannot see this either: admitTurn runs when a TURN starts
 * (agent/turn-plan.ts) and waitForMemoryHeadroom when a PUSH does (prepush/prepush.ts), while the expensive
 * thing is a command an already-admitted turn runs in the middle of itself. That gap is what this file closes,
 * and it closes it the only place all agents meet: the PreToolUse hook every Bash call is rewritten by.
 *
 * A LIST, NOT A HEURISTIC, because the set is small, local, and changes with the repo. `pnpm test` is heavy
 * here; in another workspace the heavy thing is a dbt run or a Gradle build, and neither the daemon nor a
 * cleverer matcher can know that. So the rules are config: the owner edits the file, and so can the agent, the
 * same standing the personas file has (personas/personas-store.ts argues the tracked-config case at length).
 *
 * IT IS NOT A SECURITY BOUNDARY and must never be read as one. An agent that wanted to dodge the queue could
 * spell the command differently, and an agent that wanted to exhaust the box never needed this file's
 * permission. What it prevents is the ACCIDENT: four sessions that each, reasonably, ran the suite. */

// A rule's regex is matched against at most this many characters of the command. A user-authored pattern runs
// inside the daemon's event loop, where a catastrophically-backtracking one would stall the very process this
// file exists to protect, and node has no regex timeout to hand. Bounding the SUBJECT is the part that is
// available: backtracking blowups scale with input length, and no honest command line is near this.
export const MATCH_LIMIT = 4096;

export const HeavyCommandRuleSchema = z.object({
    // Names the rule in logs and in the pane's "waiting" line. Free text; duplicates are allowed and harmless.
    id: z.string().min(1),
    // JavaScript regex SOURCE (no delimiters, no flags), matched case-insensitively. A rule whose pattern does
    // not compile is dropped with a report rather than taking the rest of the file down with it — the same
    // per-entry tolerance the personas and capability manifests have, and for the same reason: one bad
    // hand-edit must not silently switch the whole queue off.
    pattern: z.string().min(1),
    // Which slot pool this rule draws from. Rules sharing a pool contend with each other; separate pools run
    // independently. Defaults to `defaultPool` so the common case — one shared budget for everything heavy —
    // needs no per-rule field at all.
    pool: z.string().min(1).optional(),
    // Slots in this rule's pool, when it should differ from the file's `limit`. The FIRST matching rule decides
    // both pool and limit, so a pool named by two rules with different limits uses whichever matched.
    limit: z.number().int().positive().optional(),
    /* Matching this rule means the command is explicitly NOT queued, which is how a narrow exception is
     * written above the broad rule it escapes.
     *
     * It exists because the broad rules match the NAME of a heavy tool, and reading about a tool is not running
     * one: `grep -rn vitest .` matches `\bvitest\b` exactly as `npx vitest run` does, and putting a one-second
     * search behind a fifteen-minute suite is a worse bug than the one being fixed. Searching for the word is
     * something agents do constantly. */
    exempt: z.boolean().optional(),
});

export type HeavyCommandRule = z.infer<typeof HeavyCommandRuleSchema>;

export const HeavyCommandsSchema = z.object({
    // How many matching commands may run at once, across every agent session in this sandbox. Two, not one,
    // because one is a queue that serialises an agent behind an unrelated session's twenty-minute suite, and
    // the measured peak of a SINGLE bounded run (turbo concurrency 4, ~2.8 GiB by this repo's own figure in
    // turbo.json) fits twice into the headroom a 16 GiB cap leaves over a ~6-8 GiB working baseline. Four does
    // not, which is the whole finding.
    limit: z.number().int().positive().default(2),
    // Pool for rules that name none.
    defaultPool: z.string().min(1).default("heavy"),
    /* How long a command waits for a slot before running ANYWAY, in seconds.
     *
     * It runs anyway for the reason waitForMemoryHeadroom already gives for the pre-push case: this gate exists
     * to dodge a peak, not to hand whatever is holding the box a veto over someone's work. A queue that can
     * block forever turns one stuck suite into a dead sandbox, which is a worse failure than the one being
     * prevented and much harder to see. Fifteen minutes is longer than any suite in this repo. */
    waitSeconds: z.number().int().nonnegative().default(900),
    /* Whether a matching command also waits for MEMORY headroom before it starts, and for how long.
     *
     * This is the other half of the same gap: a slot says "few enough things are running", not "there is room
     * to run them". The wait reuses the daemon's own admission policy (platform/memory-admission.ts) through
     * bin/queue-run, so the number that refuses a turn and the number that holds a suite are one number.
     *
     * Shorter than `waitSeconds` on purpose: memory pressure that has not cleared in two minutes is not a peak
     * to wait out, and by then the slot limit above is the thing actually protecting the box. */
    memoryGateSeconds: z.number().int().nonnegative().default(120),
    // Matched in FILE ORDER, first match wins, so a narrow exception is written above the broad rule it
    // escapes. An empty list switches the queue off entirely, which is a supported way to turn this feature
    // off without editing the image.
    rules: z.array(HeavyCommandRuleSchema).default([]),
});

export type HeavyCommands = z.infer<typeof HeavyCommandsSchema>;

/* THE SHIPPED LIST, which is this repo's own answer and the seed for a fresh workspace's file.
 *
 * Every entry is something measured pinning this box, not everything that is merely slow. The patterns are
 * deliberately loose about HOW the command is spelled (`pnpm test`, `pnpm -w test`, `pnpm --filter x test`)
 * and strict about the verb, because the failure being prevented is a fan-out and every spelling of it fans
 * out the same. `[^&|;]*` keeps a rule inside one command of a compound line, so `git status && echo test`
 * does not read as a test run.
 *
 * `vitest` and the type checkers are listed as bare binaries as well as package scripts: a package run
 * directly (`npx vitest run`, `vue-tsc --noEmit`) skips turbo entirely and so carries NO concurrency bound at
 * all — vitest's own default is `Math.max(availableParallelism() - 1, 1)`, which is 15 workers here. */
export const DEFAULT_HEAVY_COMMANDS: HeavyCommands = HeavyCommandsSchema.parse({
    rules: [
        /* READING ABOUT A BUILD IS NOT RUNNING ONE, and it goes first because first match wins.
         *
         * Anchored at the start of the line on purpose: it exempts a command that IS a search, not one that
         * merely contains one, so `grep -rn vitest .` is free while `rg -l test && pnpm test` still queues on
         * the half that matters. Without it every one of the broad rules below doubles as a rule about the
         * agent's own code search, which is the most common thing it does. */
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

/* A rule with its pattern compiled, or nothing when the pattern does not compile.
 *
 * Case-insensitive and unanchored: a rule describes a command that APPEARS in the line, not the whole line.
 * `u` is deliberately absent — it rejects patterns an owner can reasonably write (a bare `\-`, a lone `\p`),
 * and this subject is an ASCII shell command. */
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

/* THE LINE, CUT INTO THE COMMANDS IT ACTUALLY RUNS, because a rule is about a command and an agent's Bash call
 * is frequently several.
 *
 * Matching the whole line as one string gets BOTH answers wrong, in opposite directions, and the exemptions
 * are what make it obvious: `rg -l foo && pnpm test` starts with a read-only verb, so a whole-line match reads
 * the anchored exemption and waves the suite through — a false negative on exactly the compound line an agent
 * writes when it greps for something and then runs the tests. Cutting first means each half is judged as what
 * it is.
 *
 * IT IS A SPLIT, NOT A SHELL PARSER, and the difference shows up inside quotes: `git commit -m "a; pnpm test"`
 * cuts at the semicolon and the tail reads as a test run, so that commit waits for a slot it did not need.
 * That is the direction to be wrong in — a false positive costs one command a wait, a false negative costs
 * every session on the box the twenty minutes in the resource log — and a real parser here would be a shell
 * dialect to keep correct forever, in the hot path of every Bash call, to save a rare commit message a pause. */
const SEPARATORS = /&&|\|\||[;&|\n]/u;

export const commandSegments = (command: string): string[] => command.split(SEPARATORS).filter((segment) => segment.trim() !== "");

/* WHETHER THIS COMMAND IS ONE OF THE BIG ONES, as a pure function of the line and the config, so the policy is
 * tested without a shell, a cgroup or an agent to stand in.
 *
 * The line asked about is the agent's OWN command, before any of the daemon's wrapping: by the time
 * agent-terminals.ts is done the string also holds tmux-run, an nsenter hop and `nice`, and matching against
 * that would let the daemon's own boilerplate satisfy a rule. It is also before secret resolution, so a
 * resolved credential can never reach a regex or a log line. */
export const matchHeavyCommand = (command: string, config: HeavyCommands, report?: (problem: ManifestProblem) => void): HeavyMatch | undefined => {
    // Compiled once for the whole line rather than per segment: a compound line can hold a dozen commands, and
    // a bad pattern would otherwise be reported a dozen times for one Bash call.
    const compiled = config.rules.flatMap((rule) => {
        const one = compile(rule, report);
        return one === undefined ? [] : [one];
    });
    for (const segment of commandSegments(command.slice(0, MATCH_LIMIT))) {
        for (const { rule, regex } of compiled) {
            if (!regex.test(segment)) {
                continue;
            }
            // First match decides this SEGMENT, including deciding not to queue it: an exemption is only
            // meaningful if it can stop the search before a broader rule below it gets a turn. A later segment
            // is still judged on its own, which is what makes `rg … && pnpm test` queue.
            if (rule.exempt === true) {
                break;
            }
            return { id: rule.id, pool: rule.pool ?? config.defaultPool, limit: rule.limit ?? config.limit };
        }
    }
    return undefined;
};

export interface HeavyCommandsStore {
    // The file's rules, or the shipped defaults when it is absent, unreadable, or fails the schema.
    readonly read: () => Promise<HeavyCommands>;
    // Writes the defaults if and only if the file does not exist yet, so the owner has something to edit and
    // an existing (possibly hand-tuned) file is never touched.
    readonly seed: () => Promise<void>;
}

export const fileHeavyCommandsStore = (path: string, onInvalid?: (detail: string) => void): HeavyCommandsStore => {
    const file = jsonFile<HeavyCommands | undefined>(path, {
        parse: (raw, report) => {
            const parsed = HeavyCommandsSchema.safeParse(raw);
            if (parsed.success) {
                // Compiling here rather than only at match time is what makes a bad pattern visible on the
                // screen the rule vanished from, instead of silently never matching anything.
                for (const rule of parsed.data.rules) {
                    compile(rule, report);
                }
                return parsed.data;
            }
            onInvalid?.(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            return undefined;
        },
        // `undefined` distinguishes "no usable file" from "a file that parsed", which is what lets `seed`
        // write only when there is nothing to lose. `read` collapses it to the defaults.
        fallback: () => undefined,
    });
    return {
        read: async () => (await file.read()) ?? DEFAULT_HEAVY_COMMANDS,
        seed: async () => {
            await file.update((current) => current ?? DEFAULT_HEAVY_COMMANDS);
        },
    };
};
