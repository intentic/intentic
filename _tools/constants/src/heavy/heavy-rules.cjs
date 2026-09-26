// Which programs are heavy enough to take turns, and how the queue treats them: the one table the daemon
// (_sandbox/sandbox/src/platform/resources/heavy-commands.ts), the program hook that queues a heavy program as it starts
// (heavy-hook.cjs, heavy-exec.cjs), queue-run's callers and the repository's own scripts (_tools/scripts/lib/
// heavy-slot.mjs) all read. CommonJS with no dependencies, so it loads under `node --require` in any project, on any
// Node an agent's project pins, and ES modules import it by name.
//
// A rule's `pattern` is matched against the program that actually runs and its arguments, `<program> <args…>` (`pnpm
// --filter web test`, `vitest run`, `tsc -b`), never against the shell line an agent typed: quotes, heredocs, globs and
// assignments are gone by then, and a line that only mentions a program never starts it. First match wins; an `exempt`
// rule stops the search for what it matches.
"use strict";

// What queue-run exits with when it ran nothing because the wait was up and the rule said `skip`: EX_TEMPFAIL, so a
// caller records "not measured", never "failed".
const QUEUE_SKIPPED_EXIT_CODE = 75;

// Characters of an invocation a rule's regex runs against; bounds backtracking, since node has no regex timeout.
const MATCH_LIMIT = 4096;

// The shipped rules and settings. Every rule is something measured pinning a sandbox, not merely slow.
const SHIPPED_HEAVY_COMMANDS = Object.freeze({
    // How many matching programs may run at once across the sandbox; two fits twice the peak of one bounded run.
    limit: 2,
    defaultPool: "heavy",
    // How long a program waits for a slot before running anyway, so a stuck queue cannot turn into a dead sandbox.
    waitSeconds: 900,
    // How long a matching program also waits for memory (memory-room.mjs), before its slot.
    memoryGateSeconds: 120,
    // How long a program may HOLD a slot before it is killed. Generous on purpose: this ends a hang, it does not cap
    // honest work, and a build still running after half an hour on a sandbox is already the anomaly. 0 switches it off.
    maxHoldSeconds: 1800,
    // For a rule that says nothing: for a person's command the queue must never be the reason it did not run.
    onDeadline: "run",
    rules: Object.freeze([
        // A watch, a server or a language server is meant to outlive its command, so it can neither take turns nor be
        // killed for holding a slot: queueing one holds the slot until somebody stops it. `-w` is NOT here: `pnpm -w
        // test` is a workspace-root fan-out, the heaviest command there is.
        {
            id: "long-lived",
            pattern: "--watch|--lsp\\b|\\bnodemon\\b|\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?(dev|serve|start)\\b",
            exempt: true,
        },
        // A repo-wide verification, one at a time in the same pool: two of them are the most expensive thing that can
        // happen to a sandbox at once (measured: 24.9 GiB against a 16 GiB cap), and the second is usually the same
        // work over the same tree, which turbo's cache makes nearly free once the first is done. Never two at once,
        // not even after the wait: a verification that did not run costs a check the next land repeats.
        { id: "repo-verify", pattern: "\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b", limit: 1, onDeadline: "skip" },
        // A program's name joined to `.` or `-` is another word (`check-tsc`), not the program.
        { id: "vitest", pattern: "(?<![-.])\\b(vitest|jest)\\b(?![-.])" },
        { id: "typechecker", pattern: "(?<![-.])\\b(tsc|tsgo|vue-tsc)\\b(?![-.])" },
        { id: "turbo-fanout", pattern: "\\bturbo\\b.*\\brun\\b.*\\b(build|test|typecheck|check)\\b" },
        { id: "package-script", pattern: "\\b(pnpm|npm|yarn|bun)\\b.*\\b(test|typecheck|verify|check|build)\\b" },
        { id: "cargo", pattern: "^cargo\\s+(\\+\\S+\\s+)?(build|test|check|clippy|bench|doc)\\b" },
    ]),
});

// Every rule an earlier release shipped, as it shipped it (matched against the agent's shell line then). A stored rule
// equal to one of these was seeded, not chosen, so converting a stored file drops it and the current rule takes over.
const EARLIER_SHIPPED_RULES = Object.freeze([
    {
        id: "read-only",
        pattern: "^\\s*(grep|rg|iq|ag|cat|bat|head|tail|less|ls|find|fd|wc|which|echo|git\\s+(log|status|diff|show|blame))\\b",
        exempt: true,
    },
    { id: "long-lived", pattern: "--watch|\\bnodemon\\b|\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?(dev|serve|start)\\b", exempt: true },
    { id: "repo-verify", pattern: "\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b", limit: 1 },
    { id: "repo-verify", pattern: "\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b", limit: 1, onDeadline: "skip" },
    { id: "vitest", pattern: "\\bvitest\\b" },
    { id: "vitest", pattern: "(?<![-.])\\bvitest\\b(?![-.])" },
    { id: "typechecker", pattern: "\\b(tsc|tsgo|vue-tsc)\\b" },
    { id: "typechecker", pattern: "(?<![-.])\\b(tsc|tsgo|vue-tsc)\\b(?![-.])" },
    { id: "turbo-fanout", pattern: "\\bturbo\\b[^&|;]*\\brun\\b[^&|;]*\\b(build|test|typecheck|check)\\b" },
    { id: "package-script", pattern: "\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b" },
]);

const SETTING_KEYS = Object.freeze(["limit", "defaultPool", "waitSeconds", "memoryGateSeconds", "maxHoldSeconds", "onDeadline"]);
const RULE_KEYS = Object.freeze(["id", "pattern", "pool", "limit", "maxHoldSeconds", "exempt", "onDeadline"]);

// Two rules are the same when every field either names is equal; key order and absent-versus-undefined do not count.
const sameRule = (left, right) => RULE_KEYS.every((key) => left[key] === right[key]);

// The rules and settings in force: the shipped table with the owner's overrides on top. A setting the overrides name
// replaces the shipped one; an edit naming a shipped rule's id changes the fields it names, or removes that rule
// (`disabled`); an edit naming any other id, with a pattern, is the owner's own rule, and the owner's own rules are
// matched before the shipped ones. `queue: false` stops queueing without touching how heavy programs are ranked.
const mergeHeavyRules = (overrides = {}) => {
    const settings = Object.fromEntries(SETTING_KEYS.map((key) => [key, overrides[key] ?? SHIPPED_HEAVY_COMMANDS[key]]));
    const edits = Array.isArray(overrides.ruleEdits) ? overrides.ruleEdits : [];
    const shippedIds = new Set(SHIPPED_HEAVY_COMMANDS.rules.map((rule) => rule.id));
    const editOf = new Map(edits.filter((edit) => shippedIds.has(edit.id)).map((edit) => [edit.id, edit]));
    const own = edits.filter((edit) => !shippedIds.has(edit.id) && edit.disabled !== true && typeof edit.pattern === "string");
    const shipped = SHIPPED_HEAVY_COMMANDS.rules.flatMap((rule) => {
        const edit = editOf.get(rule.id);
        if (edit === undefined) {
            return [rule];
        }
        if (edit.disabled === true) {
            return [];
        }
        const { disabled: _disabled, ...fields } = edit;
        return [{ ...rule, ...fields }];
    });
    return { ...settings, queue: overrides.queue !== false, rules: [...own.map(({ disabled: _disabled, ...rule }) => rule), ...shipped] };
};

// A stored file of the earlier shape (every setting and the whole rule list) as overrides: only what differs from what
// was shipped. A rule equal to a rule some release shipped goes, so the current one takes its place; an empty list was
// how the queue was switched off.
const overridesOf = (full) => {
    const overrides = {};
    for (const key of SETTING_KEYS) {
        if (full[key] !== undefined && full[key] !== SHIPPED_HEAVY_COMMANDS[key]) {
            overrides[key] = full[key];
        }
    }
    const rules = Array.isArray(full.rules) ? full.rules : [];
    if (Array.isArray(full.rules) && rules.length === 0) {
        overrides.queue = false;
    }
    const shipped = [...SHIPPED_HEAVY_COMMANDS.rules, ...EARLIER_SHIPPED_RULES];
    const edits = rules.filter((rule) => !shipped.some((known) => sameRule(rule, known)));
    if (edits.length > 0) {
        overrides.ruleEdits = edits.map((rule) => Object.fromEntries(RULE_KEYS.filter((key) => rule[key] !== undefined).map((key) => [key, rule[key]])));
    }
    return overrides;
};

const compileRule = (rule, report) => {
    try {
        return { rule, regex: new RegExp(rule.pattern, "i") };
    } catch (error) {
        report?.(`${rule.id}: ${error instanceof Error ? error.message : "bad pattern"}`);
        return undefined;
    }
};

// The rule a program's invocation falls under, with what the queue does with it; undefined for one that is not heavy.
const matchInvocation = (invocation, config, report) => {
    const text = invocation.slice(0, MATCH_LIMIT);
    for (const rule of config.rules) {
        const compiled = compileRule(rule, report);
        if (compiled === undefined || !compiled.regex.test(text)) {
            continue;
        }
        if (rule.exempt === true) {
            return undefined;
        }
        return {
            id: rule.id,
            pool: rule.pool ?? config.defaultPool,
            limit: rule.limit ?? config.limit,
            maxHold: rule.maxHoldSeconds ?? config.maxHoldSeconds,
            onDeadline: rule.onDeadline ?? config.onDeadline,
        };
    }
    return undefined;
};

// queue-run's flags for a match (bin/queue-run), before its `--`.
const queueArgs = (match, config) => [
    "--pool",
    match.pool,
    "--limit",
    String(match.limit),
    "--wait",
    String(config.waitSeconds),
    "--memory-gate",
    String(config.memoryGateSeconds),
    "--max-hold",
    String(match.maxHold),
    "--on-deadline",
    match.onDeadline,
    "--label",
    match.id,
];

// When a slot held this long is worth a line in the log: half of what its own rule lets it hold, never for a rule that
// lets it hold forever.
const holdWarnSeconds = (maxHold) => (maxHold > 0 ? maxHold / 2 : undefined);

// The rule a pool's holder ran under, by the label queue-run names it with, as the merged table has it.
const ruleById = (config, id) => config.rules.find((rule) => rule.id === id);

module.exports = {
    QUEUE_SKIPPED_EXIT_CODE,
    MATCH_LIMIT,
    SHIPPED_HEAVY_COMMANDS,
    EARLIER_SHIPPED_RULES,
    mergeHeavyRules,
    overridesOf,
    matchInvocation,
    queueArgs,
    holdWarnSeconds,
    ruleById,
};
