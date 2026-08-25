import { expect, test } from "vitest";
import {
    commandSegments,
    DEFAULT_HEAVY_COMMANDS,
    type HeavyCommands,
    HeavyCommandsSchema,
    MATCH_LIMIT,
    matchHeavyCommand,
} from "./heavy-commands.js";

const config = (over: Partial<HeavyCommands> = {}): HeavyCommands => HeavyCommandsSchema.parse({ ...DEFAULT_HEAVY_COMMANDS, ...over });

const matched = (command: string, over: Partial<HeavyCommands> = {}): string | undefined => matchHeavyCommand(command, config(over))?.id;

/* THE COMMANDS THE INCIDENT WAS MADE OF. Each of these is a line an agent plausibly runs in a turn, and each
 * fans out past what one 16 GiB cgroup holds when four sessions run one at the same moment. `pnpm test` is
 * the shape the resource log caught on 2026-08-25 (see heavy-commands.ts); the rest are the same fan-out
 * reached by a different spelling, which is exactly why the rules match verbs rather than whole lines. */
test.each([
    ["pnpm test", "package-script"],
    ["pnpm -w test", "package-script"],
    ["pnpm --filter @intentic/sandbox test", "package-script"],
    ["pnpm typecheck", "package-script"],
    ["pnpm verify", "package-script"],
    ["npm run build", "package-script"],
    ["yarn test", "package-script"],
    ["npx vitest run", "vitest"],
    ["vitest run src/foo.test.ts", "vitest"],
    ["vue-tsc --noEmit", "typechecker"],
    ["tsgo --noEmit -p tsconfig.test.json", "typechecker"],
    ["tsc -b tsconfig.libs.json", "typechecker"],
    ["turbo run build test", "turbo-fanout"],
    ["cd /work/intentic && pnpm test", "package-script"],
])("queues %s", (command, id) => {
    expect(matched(command)).toBe(id);
});

/* ...AND THE ONES THAT MUST STAY FREE, which is the half a matcher gets wrong. A queue that also paces `ls`
 * is not a safety feature, it is a sandbox that feels broken: every one of these returns in well under a
 * second, and several of them are what an agent runs dozens of times per turn. */
test.each([
    "ls -la",
    "git status",
    "git commit -m 'add a test for the build'",
    "cat package.json",
    "echo test",
    "npm install",
    "pnpm install --frozen-lockfile",
    "node -e 'console.log(1)'",
    "mkdir -p build",
])("leaves %s alone", (command) => {
    expect(matched(command)).toBeUndefined();
});

/* Searching for the NAME of a heavy tool is the false positive that matters, because it is the single most
 * common thing an agent does. Every one of these matches a broad rule's pattern on its face. */
test.each([
    "grep -rn vitest .",
    "rg 'pnpm test' --files-with-matches",
    "iq 'where does typecheck run'",
    "git log --oneline --grep vitest",
    "cat vitest.config.ts",
])("exempts the read-only %s", (command) => {
    expect(matched(command)).toBeUndefined();
});

test("an exemption covers the line it starts, not a line that merely contains one", () => {
    // The exempt rule is anchored, so the search half does not buy the suite half a free pass.
    expect(matched("rg -l foo && pnpm test")).toBe("package-script");
    expect(matched("grep -rn vitest .")).toBeUndefined();
});

test("a compound line is judged one command at a time", () => {
    expect(commandSegments("rg -l foo && pnpm test")).toEqual(["rg -l foo ", " pnpm test"]);
    expect(commandSegments("a | b; c\nd")).toEqual(["a ", " b", " c", "d"]);
    expect(commandSegments("   ")).toEqual([]);
    // Every separator that starts a new command has to cut, or a heavy tail hides behind an exempt head.
    for (const line of ["grep x && pnpm test", "grep x || pnpm test", "grep x; pnpm test", "grep x | pnpm test", "grep x\npnpm test"]) {
        expect(matched(line)).toBe("package-script");
    }
});

test("the split is not a shell parser, and a quoted separator over-matches by design", () => {
    /* Documented rather than fixed: a false positive costs one command a wait, a false negative costs every
     * session on the box the twenty minutes in the resource log. Asserted so that if someone later teaches
     * this to parse quotes, the behaviour change is deliberate rather than a surprise. */
    expect(matched(`git commit -m "a; pnpm test"`)).toBe("package-script");
    expect(matched(`git commit -m "add a test"`)).toBeUndefined();
});

test("a rule stays inside one command of a compound line", () => {
    // `[^&|;]*` is what stops `pnpm` on one side of a `&&` from reaching a verb on the other.
    expect(matched("pnpm install && git status")).toBeUndefined();
    expect(matched("pnpm install; pnpm test")).toBe("package-script");
});

test("first match wins, so a narrow rule above a broad one decides", () => {
    const rules = [
        { id: "narrow", pattern: "vitest run src/one", pool: "solo", limit: 1 },
        { id: "broad", pattern: "\\bvitest\\b" },
    ];
    expect(matchHeavyCommand("vitest run src/one.test.ts", config({ rules }))).toEqual({ id: "narrow", pool: "solo", limit: 1 });
    expect(matchHeavyCommand("vitest run src/two.test.ts", config({ rules }))).toEqual({ id: "broad", pool: "heavy", limit: 2 });
});

test("a rule's own pool and limit override the file's, and absent ones inherit", () => {
    const parsed = config({
        limit: 3,
        defaultPool: "big",
        rules: [
            { id: "a", pattern: "aaa" },
            { id: "b", pattern: "bbb", pool: "own", limit: 1 },
        ],
    });
    expect(matchHeavyCommand("aaa", parsed)).toEqual({ id: "a", pool: "big", limit: 3 });
    expect(matchHeavyCommand("bbb", parsed)).toEqual({ id: "b", pool: "own", limit: 1 });
});

test("an empty rule list switches the queue off", () => {
    // The supported way to turn this off without touching the image, so it has to actually match nothing.
    expect(matchHeavyCommand("pnpm test", config({ rules: [] }))).toBeUndefined();
});

test("a rule whose pattern does not compile is reported and skipped, and the rest still match", () => {
    const problems: string[] = [];
    const parsed = config({
        rules: [
            { id: "broken", pattern: "([unclosed" },
            { id: "fine", pattern: "\\bvitest\\b" },
        ],
    });
    // The point is the SECOND rule: one bad hand-edit must not silently switch the whole queue off, which is
    // what a throw here would do — the hook swallows errors and would then queue nothing at all.
    expect(matchHeavyCommand("npx vitest run", parsed, (problem) => problems.push(problem.detail))).toEqual({ id: "fine", pool: "heavy", limit: 2 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken");
});

test("matching is case-insensitive", () => {
    expect(matched("PNPM TEST")).toBe("package-script");
});

test("only the first MATCH_LIMIT characters are searched", () => {
    /* A user-authored regex runs inside the daemon's event loop and node has no regex timeout, so the subject
     * is bounded instead. The cap has to genuinely cut, or it is decoration. */
    const padded = `${"x".repeat(MATCH_LIMIT)} pnpm test`;
    expect(matched(padded)).toBeUndefined();
    expect(matched(`pnpm test ${"x".repeat(MATCH_LIMIT)}`)).toBe("package-script");
});

test("the shipped defaults parse, and describe a bounded queue", () => {
    // Two, not four: the finding this whole file exists for is that four concurrent fan-outs do not fit.
    expect(DEFAULT_HEAVY_COMMANDS.limit).toBe(2);
    expect(DEFAULT_HEAVY_COMMANDS.rules.length).toBeGreaterThan(0);
    expect(DEFAULT_HEAVY_COMMANDS.waitSeconds).toBeGreaterThan(0);
    expect(DEFAULT_HEAVY_COMMANDS.memoryGateSeconds).toBeGreaterThan(0);
});
