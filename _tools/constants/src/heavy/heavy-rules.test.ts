import {
    EARLIER_SHIPPED_RULES,
    type HeavyCommandOverrides,
    holdWarnSeconds,
    MATCH_LIMIT,
    matchInvocation,
    mergeHeavyRules,
    overridesOf,
    queueArgs,
    SHIPPED_HEAVY_COMMANDS,
    sizeArgs,
    targetedRun,
} from "./heavy-rules.cjs";

// A rule is matched against the program that runs and the arguments it got, `<program> <args…>`: the hook and the
// wrappers build exactly this string from the process itself, never from the line an agent typed.
const matched = (invocation: string, overrides: HeavyCommandOverrides = {}): string | undefined => matchInvocation(invocation, mergeHeavyRules(overrides))?.id;

const HOLD = SHIPPED_HEAVY_COMMANDS.maxHoldSeconds;

// What each fan-out an incident was made of looks like as the program that ran it.
test.each([
    ["pnpm test", "package-script"],
    ["pnpm -w test", "package-script"],
    ["pnpm --filter @intentic/sandbox test", "package-script"],
    ["pnpm typecheck", "package-script"],
    ["pnpm verify", "repo-verify"],
    ["pnpm run verify:turn", "repo-verify"],
    ["npm run build", "package-script"],
    ["yarn test", "package-script"],
    ["bun test src/x.test.ts", "package-script"],
    ["npx vitest run", "vitest"],
    ["vitest run src/foo.test.ts", "vitest"],
    ["jest --ci", "vitest"],
    ["vue-tsc --noEmit", "typechecker"],
    ["tsgo --noEmit -p tsconfig.test.json", "typechecker"],
    ["tsc -b tsconfig.libs.json", "typechecker"],
    ["turbo run build test", "turbo-fanout"],
    ["cargo build --release", "cargo"],
    ["cargo +nightly test", "cargo"],
])("the program %s is heavy under %s", (invocation, id) => {
    expect(matched(invocation)).toBe(id);
});

// Programs that must stay free: several run dozens of times per turn.
test.each([
    "git status",
    "pnpm install-completion",
    "pnpm run install-hooks",
    "node -e console.log(1)",
    "check-tsc --fast",
    "cargo fmt",
    "prettier --write vitest.config.ts",
])("the program %s is left alone", (invocation) => {
    expect(matched(invocation)).toBeUndefined();
});

// A watch, a dev server or a language server outlives its command; queueing one holds a slot until somebody stops it.
test.each(["vitest --watch", "vitest --watchAll", "pnpm test --watch=true", "vue-tsc --noEmit --watch", "tsgo --lsp --stdio", "pnpm dev", "pnpm run dev:web", "npm start", "nodemon src/index.ts"])(
    "the long-lived program %s is exempt",
    (invocation) => {
        expect(matched(invocation)).toBeUndefined();
    },
);

// An agent may install inside its turn, and the daemon installs beside it: every install takes one lane, one at a time,
// whichever manager and however it is spelled, including the ones that add a test runner or a type-checker.
test.each([
    "npm install",
    "npm i",
    "pnpm install --frozen-lockfile",
    "pnpm add -D vitest",
    "pnpm add -D vue-tsc",
    "pnpm --filter web add zod",
    "pnpm -C app i",
    "npm --prefix app ci",
    "pnpm --silent install",
    "yarn remove left-pad",
    "bun install",
    "bun add left-pad",
    "npm install -g typescript",
])("the install %s takes the install lane", (invocation) => {
    expect(matchInvocation(invocation, mergeHeavyRules())).toEqual({ id: "dependency-install", pool: "install", limit: 1, maxHold: HOLD, onDeadline: "run" });
});

test("a test run that merely mentions an install is a test run", () => {
    expect(matched("pnpm --filter web test -- --grep install")).toBe("package-script");
});

test("a repo-wide verification is limited to one, skips at its deadline, and stays in the shared pool", () => {
    expect(matchInvocation("pnpm verify:turn", mergeHeavyRules())).toEqual({ id: "repo-verify", pool: "heavy", limit: 1, maxHold: HOLD, onDeadline: "skip" });
    expect(matchInvocation("pnpm test", mergeHeavyRules())).toEqual({ id: "package-script", pool: "heavy", limit: 2, maxHold: HOLD, onDeadline: "run" });
});

test("matching is case-insensitive, and only the first MATCH_LIMIT characters are searched", () => {
    expect(matched("PNPM TEST")).toBe("package-script");
    expect(matched(`${"x".repeat(MATCH_LIMIT)} pnpm test`)).toBeUndefined();
    expect(matched(`pnpm test ${"x".repeat(MATCH_LIMIT)}`)).toBe("package-script");
});

test("a rule whose pattern does not compile is reported and skipped, and the rest still match", () => {
    const problems: string[] = [];
    const config = mergeHeavyRules({ ruleEdits: [{ id: "broken", pattern: "([unclosed" }] });
    expect(matchInvocation("npx vitest run", config, (detail) => problems.push(detail))?.id).toBe("vitest");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("broken: ");
});

// THE STORED FILE IS OVERRIDES. A fix to a shipped rule reaches every sandbox; only what the owner changed is theirs.
describe("the owner's overrides on top of the shipped table", () => {
    test("no overrides is the shipped table, with the queue on", () => {
        expect(mergeHeavyRules({})).toEqual({ ...SHIPPED_HEAVY_COMMANDS, queue: true, rules: [...SHIPPED_HEAVY_COMMANDS.rules] });
    });

    test("a setting the overrides name replaces the shipped one, and only that one", () => {
        expect(mergeHeavyRules({ limit: 3, waitSeconds: 60 })).toMatchObject({ limit: 3, waitSeconds: 60, memoryGateSeconds: 120, defaultPool: "heavy" });
    });

    test("an edit changes the fields it names on the shipped rule of its id, or removes that rule", () => {
        const edited = mergeHeavyRules({ ruleEdits: [{ id: "vitest", maxHoldSeconds: 7200 }, { id: "cargo", disabled: true }] });
        expect(edited.rules.find((rule) => rule.id === "vitest")).toEqual({ id: "vitest", pattern: "(?<![-.])\\b(vitest|jest)\\b(?![-.])", maxHoldSeconds: 7200 });
        expect(edited.rules.map((rule) => rule.id)).not.toContain("cargo");
        expect(matchInvocation("vitest run", edited)?.maxHold).toBe(7200);
    });

    test("the owner's own rules are matched before the shipped ones, and need a pattern", () => {
        const own = mergeHeavyRules({ ruleEdits: [{ id: "bun-test", pattern: "\\bbun\\s+test\\b|\\bsuites\\b", pool: "tests", limit: 4 }, { id: "no-pattern" }] });
        expect(own.rules[0]).toEqual({ id: "bun-test", pattern: "\\bbun\\s+test\\b|\\bsuites\\b", pool: "tests", limit: 4 });
        expect(own.rules.map((rule) => rule.id)).not.toContain("no-pattern");
        expect(matchInvocation("bun test", own)).toEqual({ id: "bun-test", pool: "tests", limit: 4, maxHold: HOLD, onDeadline: "run" });
    });

    test("switching the queue off keeps every rule, so heavy programs are still recognised and ranked", () => {
        const off = mergeHeavyRules({ queue: false });
        expect(off.queue).toBe(false);
        expect(matchInvocation("pnpm test", off)?.id).toBe("package-script");
    });
});

// The conversion that turns a file of the earlier shape (the whole table, seeded once) into overrides.
describe("a stored table converted into overrides", () => {
    // What the shipped seed wrote, byte for byte as a sandbox of that release has it.
    const seeded = {
        limit: 2,
        defaultPool: "heavy",
        waitSeconds: 900,
        memoryGateSeconds: 120,
        maxHoldSeconds: 1800,
        onDeadline: "run",
        rules: [
            EARLIER_SHIPPED_RULES[0],
            { id: "long-lived", pattern: "--watch|\\bnodemon\\b|\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?(dev|serve|start)\\b", exempt: true },
            { id: "repo-verify", pattern: "\\b(pnpm|npm|yarn|bun)\\s+(run\\s+)?verify(:\\S+)?\\b", limit: 1 },
            { id: "vitest", pattern: "\\bvitest\\b" },
            { id: "typechecker", pattern: "\\b(tsc|tsgo|vue-tsc)\\b" },
            { id: "turbo-fanout", pattern: "\\bturbo\\b[^&|;]*\\brun\\b[^&|;]*\\b(build|test|typecheck|check)\\b" },
            { id: "package-script", pattern: "\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\b(test|typecheck|verify|check|build)\\b" },
        ],
    } as const;

    test("a file that is only what some release seeded converts to no overrides at all, so today's rules apply", () => {
        expect(overridesOf(seeded)).toEqual({});
    });

    // This workspace's own file: the seed plus one rule an owner added for the repository's test runner.
    test("what the owner added or changed survives, and nothing else", () => {
        const ownRule = { id: "bun-test", pattern: "\\bbun\\s+test\\b|(?<![-.])\\bsuites\\b(?![-.])", pool: "tests", limit: 4 };
        const tuned = { ...seeded, limit: 3, rules: [...seeded.rules.slice(0, 3), ownRule, { id: "vitest", pattern: "\\bvitest\\b", maxHoldSeconds: 60 }] };
        expect(overridesOf(tuned)).toEqual({ limit: 3, ruleEdits: [ownRule, { id: "vitest", pattern: "\\bvitest\\b", maxHoldSeconds: 60 }] });
    });

    test("an empty rule list, which switched the queue off, becomes the queue switched off", () => {
        expect(overridesOf({ ...seeded, rules: [] })).toEqual({ queue: false });
    });

    test("converting what a conversion wrote changes nothing", () => {
        const once = overridesOf({ ...seeded, onDeadline: "skip", rules: [] });
        expect(mergeHeavyRules(once)).toMatchObject({ onDeadline: "skip", queue: false });
        expect(overridesOf({ ...mergeHeavyRules(once), rules: undefined })).toEqual({ onDeadline: "skip" });
    });
});

test("queue-run is handed the rule's own flags, in the order it parses them", () => {
    const config = mergeHeavyRules();
    const match = matchInvocation("pnpm verify", config);
    expect(match === undefined ? [] : queueArgs(match, config)).toEqual([
        "--pool",
        "heavy",
        "--limit",
        "1",
        "--wait",
        "900",
        "--memory-gate",
        "120",
        "--max-hold",
        "1800",
        "--on-deadline",
        "skip",
        "--label",
        "repo-verify",
    ]);
});

test.each([
    ["pnpm --filter @intentic/sandbox test src/logs/filter-stats.test.ts", true],
    ["pnpm --filter @intentic/sandbox test filter-stats", true],
    ["bun test --conditions=@intentic/src src/a.test.ts", true],
    ["/usr/local/bin/bun test x.test.ts", true],
    ["vitest run src/x", true],
    ["pnpm test -- src/foo.test.ts", true],
    ["pnpm test", false],
    ["pnpm --filter web test", false],
    ["bun test --timeout 5000", false],
    ["bun test --reporter dot", false],
    ["vitest run", false],
    ["pnpm -r test foo/bar", false],
    ["turbo run test --filter=web", false],
    ["pnpm --filter @intentic/web typecheck", false],
] as const)("whether %s names the files it runs: %s", (invocation, targeted) => {
    expect(targetedRun(invocation)).toBe(targeted);
});

test("only a test rule's targeted run asks the gate for the smaller price", () => {
    const config = mergeHeavyRules();
    const sized = (invocation: string): string[] => {
        const match = matchInvocation(invocation, config);
        return match === undefined ? [] : sizeArgs(match, invocation);
    };
    expect(sized("pnpm --filter @intentic/sandbox test src/a.test.ts")).toEqual(["--size", "targeted"]);
    expect(sized("vitest run src/a.test.ts")).toEqual(["--size", "targeted"]);
    expect(sized("pnpm verify src/a.test.ts")).toEqual([]);
    expect(sized("tsc -p src/a.test.ts")).toEqual([]);
});

test("a hold is worth a warning at half of what its rule allows, and never for a rule that allows forever", () => {
    expect(holdWarnSeconds(1800)).toBe(900);
    expect(holdWarnSeconds(7)).toBe(3.5);
    expect(holdWarnSeconds(0)).toBeUndefined();
});
