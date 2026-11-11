import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCommandRuns, commandFailuresAnswer, commandRunLines, commandSignature, type FailedCommand } from "./command-runs-log.js";

// The command record across conversations: appended per turn, read back grouped by kind, and each kind told ongoing,
// stopped (its program ran clean in other conversations since) or quiet.

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");

const missingPytest: FailedCommand = {
    command: "pytest -q",
    program: "pytest",
    exit: 127,
    unstarted: true,
    error: "bash: line 1: pytest: command not found",
    tail: "bash: line 1: pytest: command not found",
    instead: "python -m pytest -q",
};
const pushRefused: FailedCommand = { command: "git push", program: "git push", exit: 1, error: "fatal: could not read Username for 'https://github.com'", tail: "" };

const turn = (conversationId: string, at: number, failures: readonly FailedCommand[], ran: Record<string, number> = {}) =>
    commandRunLines({ at, conversationId, turnId: `${conversationId}-t`, runtime: "claude-code" }, { failures, failed: failures.length, ran });

const recorded = async (...turns: ReturnType<typeof turn>[]): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-commands-"));
    roots.push(root);
    for (const lines of turns) {
        await appendCommandRuns(root, lines);
    }
    return root;
};

const window = { now: NOW };

test("groups a failure by program and error, whatever path or number it named", () => {
    expect(commandSignature("pnpm vitest", "Error: Cannot find module '/work/a/b.ts' at line 12")).toBe(commandSignature("pnpm vitest", "Error: Cannot find module '/work/c.ts' at line 9"));
    expect(commandSignature("node", "Error: ENOENT: no such file or directory, open /work/x/y.json")).toBe("node · Error: ENOENT: no such file or directory, open <path>");
});

test("a turn that ran no command adds nothing, and one that did writes its failures before its clean runs", async () => {
    expect(turn("quiet-fox", NOW, [])).toStrictEqual([]);
    const root = await recorded(turn("busy-owl", NOW, [missingPytest], { "python -m pytest": 1 }));
    const lines = (await readFile(join(root, "logs", "command-runs.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => /"kind":"(\w+)"/.exec(line)?.[1])).toStrictEqual(["failure", "turn"]);
    // The stamp leads the line, where the log reader looks for it without parsing.
    expect(lines.every((line) => line.startsWith('{"at":'))).toBe(true);
});

test("tells a failure that stopped from one still recurring and one nobody ran again", async () => {
    const root = await recorded(
        turn("a", NOW - 100 * HOUR, [missingPytest]),
        turn("b", NOW - 90 * HOUR, [missingPytest]),
        // Two other conversations ran pytest clean after its last failure: the environment was fixed.
        turn("c", NOW - 80 * HOUR, [], { pytest: 2 }),
        turn("d", NOW - 70 * HOUR, [], { pytest: 1 }),
        turn("e", NOW - 2 * HOUR, [pushRefused]),
        turn("f", NOW - HOUR, [pushRefused]),
        turn("g", NOW - 200 * HOUR, [{ ...pushRefused, program: "gh pr", command: "gh pr create", error: "gh: command not found" }]),
    );
    const answer = await commandFailuresAnswer(root, { window, group: true, limit: undefined });
    expect(answer).toContain("5 failed commands in everything kept (2 never started), in 5 conversations.");
    expect(answer).toContain("ongoing · 2 conversations, 2× · last 1h ago\n  git push · fatal: could not read Username for <name>");
    expect(answer).toContain(
        "stopped · 2 conversations, 2× · last 4d ago · never started · ran clean in 2 other conversations since\n  pytest · bash: line <n>: pytest: command not found\n  e.g. `pytest -q` (never started) → then `python -m pytest -q`",
    );
    expect(answer).toContain("quiet · 1 conversation, 1× · last 8d ago\n  gh pr · gh: command not found");
});

test("one conversation's failures are listed one by one, newest first", async () => {
    const root = await recorded(turn("a", NOW - 2 * HOUR, [missingPytest]), turn("a", NOW - HOUR, [pushRefused]), turn("b", NOW, [pushRefused]));
    const answer = await commandFailuresAnswer(root, { window, conversationId: "a", group: false, limit: undefined });
    expect(answer).toContain("2 failed commands in everything kept (1 never started), in 1 conversation.");
    const push = answer.indexOf("`git push`");
    const pytest = answer.indexOf("`pytest -q`");
    expect(push).toBeGreaterThan(-1);
    expect(pytest).toBeGreaterThan(push);
    expect(answer).toContain("  → then `python -m pytest -q`");
});

test("says so when nothing failed, and how far the record reaches", async () => {
    const root = await recorded();
    expect(await commandFailuresAnswer(root, { window, group: true, limit: undefined })).toBe("No failed commands in everything kept.\ncommand-runs.jsonl does not exist yet.");
});
