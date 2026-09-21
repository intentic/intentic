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

// Read, not written out: the shipped ceiling is tuned by measurement, and these assertions are about inheritance.
const HOLD = DEFAULT_HEAVY_COMMANDS.maxHoldSeconds;

// Commands the incident was made of: each fans out past what a 16 GiB cgroup holds when four sessions run one at once,
// matched by verb since a different spelling reaches the same fan-out.
test.each([
    ["pnpm test", "package-script"],
    ["pnpm -w test", "package-script"],
    ["pnpm --filter @intentic/sandbox test", "package-script"],
    ["pnpm typecheck", "package-script"],
    // Above package-script now, and limited to one: see the repo-verify rule for the measurement.
    ["pnpm verify", "repo-verify"],
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

// Commands that must stay free: pacing any of these would feel broken, since several run dozens of times per turn.
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

// Searching for a heavy tool's name is the false positive that matters, since it's the most common thing an agent does.
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
    expect(matched("rg -l foo && pnpm test")).toBe("package-script");
    expect(matched("grep -rn vitest .")).toBeUndefined();
});

test("a compound line is judged one command at a time", () => {
    expect(commandSegments("rg -l foo && pnpm test")).toEqual(["rg -l foo ", " pnpm test"]);
    expect(commandSegments("a | b; c\nd")).toEqual(["a ", " b", " c", "d"]);
    expect(commandSegments("   ")).toEqual([]);
    // Every separator that starts a new command must cut, or a heavy tail hides behind an exempt head.
    for (const line of ["grep x && pnpm test", "grep x || pnpm test", "grep x; pnpm test", "grep x | pnpm test", "grep x\npnpm test"]) {
        expect(matched(line)).toBe("package-script");
    }
});

test("a quoted argument is data: naming a heavy command inside one does not queue the command that carries it", () => {
    expect(matched(`git commit -m "a; pnpm test"`)).toBeUndefined();
    expect(matched(`git commit -m "add a test"`)).toBeUndefined();
    // A shell's quoted argument is not data, it is the command; those still match, over-matching the safe way.
    expect(matched(`bash -c "pnpm test"`)).toBe("package-script");
    expect(matched(`sh -c 'pnpm run build'`)).toBe("package-script");
    expect(matched(`/usr/bin/zsh -c "pnpm test"`)).toBe("package-script");
});

// The same regression one layer out, and the one that cost the 18 seconds: a `case` label is a GLOB, so it is neither
// quoted (nothing to blank) nor a command (nothing runs). Splitting on `|` — which a case label uses as its own
// alternation — then left the bare word `*vue-tsc*` as a segment, and `\b(tsc|tsgo|vue-tsc)\b` matched it. The line
// below is the shape of the /proc accounting loop that hit it: it reads memory and runs no tool at all.
test("a glob is a pattern, not a program: shell syntax naming a tool does not queue the line", () => {
    const census = `for p in [0-9]*; do case "$c" in *vue-tsc*|*tsc.js*) k=typecheck ;; *vitest*) k=vitest ;; esac; done`;
    expect(matched(census)).toBeUndefined();
    // A glob among a real command's arguments is blanked too, and the command still matches on its own words.
    expect(matched(`vitest run src/**/*.test.ts`)).toBe("vitest");
    expect(matched(`turbo run build --filter=./packages/*`)).toBe("turbo-fanout");
    // A comment names a tool for a person, not for a shell.
    expect(matched(`ps -eo args  # remember to run pnpm test`)).toBeUndefined();
    // An assignment is a variable, not a command; the one that PRECEDES real work still leaves the work matchable.
    expect(matched(`role=vitest`)).toBeUndefined();
    expect(matched(`VITEST_MAX_WORKERS=4 turbo run test`)).toBe("turbo-fanout");
});

// The regression: a quoted program is ARGUMENT text, and cutting it into fragments matched the rules against lines
// that never ran. Measured before this: the awk line below waited in the heavy pool behind two repo-wide test runs.
test("a separator inside quotes belongs to its argument, not to the command line", () => {
    const awk = `ps -eo args --no-headers | awk '{ if (x ~ /vitest/) role="vitest"; else if (x ~ /turbo/) role="turbo" }' | sort`;
    expect(commandSegments(awk)).toEqual(["ps -eo args --no-headers ", ` awk '{ if (x ~ /vitest/) role="vitest"; else if (x ~ /turbo/) role="turbo" }' `, " sort"]);
    expect(matched(awk)).toBeUndefined();
    // Single quotes are literal all the way through, double quotes hold their own separators too.
    expect(commandSegments(`echo 'a|b' && echo "c;d"`)).toEqual(["echo 'a|b' ", ` echo "c;d"`]);
    // A quote inside the other kind closes nothing, so the run does not end early and split the rest.
    expect(commandSegments(`echo "it's | fine" ; ls`)).toEqual([`echo "it's | fine" `, " ls"]);
    // An unbalanced quote keeps its tail whole rather than splitting text nobody can parse.
    expect(commandSegments(`echo "unclosed | tail`)).toEqual([`echo "unclosed | tail`]);
    // A backslash-escaped separator is not one; the shell would not have split there either.
    expect(commandSegments(String.raw`echo a\|b | wc -l`)).toEqual([String.raw`echo a\|b `, " wc -l"]);
});

// The other half of the same contract: honouring quotes must not let a real heavy command hide inside them.
test("a real command after a quoted argument is still judged on its own", () => {
    expect(matched(`echo 'nothing here' && pnpm test`)).toBe("package-script");
    expect(matched(`grep -rn "a; b" . | pnpm run build`)).toBe("package-script");
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
    expect(matchHeavyCommand("vitest run src/one.test.ts", config({ rules }))).toEqual({ id: "narrow", pool: "solo", limit: 1, maxHold: HOLD, onDeadline: "run" });
    expect(matchHeavyCommand("vitest run src/two.test.ts", config({ rules }))).toEqual({ id: "broad", pool: "heavy", limit: 2, maxHold: HOLD, onDeadline: "run" });
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
    expect(matchHeavyCommand("aaa", parsed)).toEqual({ id: "a", pool: "big", limit: 3, maxHold: HOLD, onDeadline: "run" });
    expect(matchHeavyCommand("bbb", parsed)).toEqual({ id: "b", pool: "own", limit: 1, maxHold: HOLD, onDeadline: "run" });
});

test("a rule's own hold ceiling overrides the file's, and zero means never killed", () => {
    const parsed = config({
        maxHoldSeconds: 60,
        rules: [
            { id: "capped", pattern: "aaa" },
            { id: "looser", pattern: "bbb", maxHoldSeconds: 7200 },
            { id: "forever", pattern: "ccc", maxHoldSeconds: 0 },
        ],
    });
    expect(matchHeavyCommand("aaa", parsed)?.maxHold).toBe(60);
    expect(matchHeavyCommand("bbb", parsed)?.maxHold).toBe(7200);
    // Not `?? config.maxHoldSeconds`: an explicit 0 is the opt-out, and nullish coalescing is what keeps it one.
    expect(matchHeavyCommand("ccc", parsed)?.maxHold).toBe(0);
});

test("a rule's own deadline answer overrides the file's, and the shipped default runs anyway", () => {
    const parsed = config({
        onDeadline: "skip",
        rules: [
            { id: "skips", pattern: "aaa" },
            { id: "runs", pattern: "bbb", onDeadline: "run" },
        ],
    });
    expect(matchHeavyCommand("aaa", parsed)?.onDeadline).toBe("skip");
    expect(matchHeavyCommand("bbb", parsed)?.onDeadline).toBe("run");
    expect(DEFAULT_HEAVY_COMMANDS.onDeadline).toBe("run");
    // The one shipped rule that skips: two repo-wide verifications overlapping is the measured peak.
    expect(matchHeavyCommand("pnpm test", config())?.onDeadline).toBe("run");
    expect(matchHeavyCommand("pnpm verify:turn", config())?.onDeadline).toBe("skip");
});

// A watch or a dev server is supposed to outlive its command. Queueing one means a slot held until the user stops
// it, and the ceiling would then kill work the user is watching — so neither applies: it is never queued at all.
test.each([
    "vitest --watch",
    "vitest --watchAll",
    "pnpm test --watch=true",
    "vue-tsc --noEmit --watch",
    "pnpm dev",
    "pnpm run dev:web",
    "pnpm run serve",
    "npm start",
    "nodemon src/index.ts",
])("%s is exempt, not queued", (command) => {
    expect(matched(command)).toBeUndefined();
});

// `-w` is pnpm's workspace-root flag, not a watch: exempting it would free the widest fan-out in the repo.
test("pnpm -w test is still queued, because -w is not a watch flag", () => {
    expect(matched("pnpm -w test")).toBe("package-script");
});

// The exemption must not swallow the batch commands it sits above.
test.each([
    ["vitest run", "vitest"],
    ["pnpm test", "package-script"],
    ["vue-tsc --noEmit -p tsconfig.json", "typechecker"],
])("%s is still queued despite the long-lived exemption", (command, id) => {
    expect(matched(command)).toBe(id);
});

test("a repo-wide verification is limited to one, and stays in the pool with everything else", () => {
    const verify = matchHeavyCommand("pnpm verify:turn", config());
    expect(verify).toEqual({ id: "repo-verify", pool: "heavy", limit: 1, maxHold: HOLD, onDeadline: "skip" });
    // Same pool as the rest, so serialising these does not raise how many heavy commands the box runs at once.
    expect(verify?.pool).toBe(config().defaultPool);
    expect(matched("pnpm run verify:turn")).toBe("repo-verify");
});

test("the verify rule does not swallow the package scripts it sits above", () => {
    expect(matched("pnpm test")).toBe("package-script");
    expect(matched("pnpm typecheck")).toBe("package-script");
    // Still the file's limit, so ordinary heavy commands keep both slots.
    expect(matchHeavyCommand("pnpm test", config())?.limit).toBe(2);
});

test("an empty rule list switches the queue off", () => {
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
    expect(matchHeavyCommand("npx vitest run", parsed, (problem) => problems.push(problem.detail))).toEqual({
        id: "fine",
        pool: "heavy",
        limit: 2,
        maxHold: HOLD,
        onDeadline: "run",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken");
});

test("matching is case-insensitive", () => {
    expect(matched("PNPM TEST")).toBe("package-script");
});

test("only the first MATCH_LIMIT characters are searched", () => {
    // Bounded since node has no regex timeout for a user-authored pattern; the cap must actually cut, not just exist.
    const padded = `${"x".repeat(MATCH_LIMIT)} pnpm test`;
    expect(matched(padded)).toBeUndefined();
    expect(matched(`pnpm test ${"x".repeat(MATCH_LIMIT)}`)).toBe("package-script");
});

test("the shipped defaults parse, and describe a bounded queue", () => {
    // Two, not four; four concurrent fan-outs do not fit in the box's headroom.
    expect(DEFAULT_HEAVY_COMMANDS.limit).toBe(2);
    expect(DEFAULT_HEAVY_COMMANDS.rules.length).toBeGreaterThan(0);
    expect(DEFAULT_HEAVY_COMMANDS.waitSeconds).toBeGreaterThan(0);
    expect(DEFAULT_HEAVY_COMMANDS.memoryGateSeconds).toBeGreaterThan(0);
});
