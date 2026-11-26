import { test, expect } from "bun:test";
import { commandSignature, parseStatsFile, summarizeStats, summarizeHarm, summarizeArms } from "../stats/filter-stats.mjs";

test("summarizeStats: saved-% and tokens come from the cleaned population only", () => {
    const rows = [
        { command: "pnpm i", rawBytes: 4000, emittedBytes: 400, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 3600 } },
        { command: "vitest", rawBytes: 8000, emittedBytes: 800, matched: ["test"], heldOut: false, stageBytes: { test: 6000, cap: 1200 } },
    ];
    const report = summarizeStats(rows);
    expect(report.commands).toBe(2);
    expect(report.rawTokens).toBe(3000);
    expect(report.emittedTokens).toBe(300);
    expect(report.savedPct).toBe(90);
    // Ranked by tokens saved, not by how often a mechanism fired.
    expect(report.perCleaner).toEqual([
        { id: "test", commands: 1, savedTokens: 1500 },
        { id: "pnpm", commands: 1, savedTokens: 900 },
        { id: "cap", commands: 1, savedTokens: 300 },
    ]);
});

// Rows the filter writes carry its token estimate; a row from before it counts four bytes a token.
test("summarizeStats: a row's recorded tokens count, and a row without them counts four bytes a token", () => {
    const rows = [
        // ls-style padding: 4000 bytes the estimate puts at 1600 tokens, trimmed to 400 bytes at 100.
        { command: "ls -la", rawBytes: 4000, emittedBytes: 400, rawTokens: 1600, emittedTokens: 100, matched: ["ls"], heldOut: false, stageBytes: { ls: 3600 } },
        { command: "pnpm i", rawBytes: 4000, emittedBytes: 400, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 3600 } },
        { command: "weird-tool run", rawBytes: 9000, emittedBytes: 9000, rawTokens: 3500, emittedTokens: 3500, matched: [], heldOut: false },
    ];
    const report = summarizeStats(rows);
    expect(report.rawTokens).toBe(1600 + 1000 + 3500);
    expect(report.emittedTokens).toBe(100 + 100 + 3500);
    expect(report.savedPct).toBe(Math.round(((6100 - 3700) / 6100) * 100));
    // A stage's bytes at its own row's rate: 3600 bytes of a row at 0.4 tokens a byte are 1440 tokens, not 900.
    expect(report.perCleaner).toEqual([
        { id: "ls", commands: 1, savedTokens: 1440 },
        { id: "pnpm", commands: 1, savedTokens: 900 },
    ]);
    expect(report.gaps).toEqual([{ command: "weird-tool", commands: 1, tokens: 3500 }]);
});

test("summarizeStats: held-out rows form the measured control and never count as gaps", () => {
    const rows = [
        { command: "big-build", rawBytes: 10_000, emittedBytes: 1000, matched: ["build"], heldOut: false },
        { command: "big-build", rawBytes: 10_000, emittedBytes: 10_000, matched: [], heldOut: true },
    ];
    const report = summarizeStats(rows);
    expect(report.holdout.cleaned).toBe(1);
    expect(report.holdout.heldOut).toBe(1);
    // One command per arm cannot measure anything, however large the gap looks.
    expect(report.holdout.measuredSavedPct).toBeUndefined();
    // The held-out row has no cleaner match but must not be reported as a gap.
    expect(report.gaps).toEqual([]);
});

// The holdout is the only estimate here; it publishes nothing it cannot support, using medians since output sizes are
// heavy-tailed.
test("summarizeStats: a separated holdout publishes the median saving", () => {
    const rows = [
        ...Array.from({ length: 200 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 1000 + i, matched: ["x"], heldOut: false })),
        ...Array.from({ length: 60 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 2000 + i, matched: [], heldOut: true })),
    ];
    // Median emitted (cleaned) 1100 vs median raw (held) 2030 gives ~46%.
    expect(summarizeStats(rows).holdout.measuredSavedPct).toBe(46);
});

test("summarizeStats: a holdout the cleaners did not separate publishes no number at all", () => {
    // Same distribution either means an ineffective config or a real one on too short a window; either way the report
    // stays silent rather than guess.
    const rows = [
        ...Array.from({ length: 200 }, (_, i) => ({
            command: "c",
            rawBytes: 2000 + (i % 60),
            emittedBytes: 2000 + (i % 60),
            matched: ["x"],
            heldOut: false,
        })),
        ...Array.from({ length: 60 }, (_, i) => ({
            command: "c",
            rawBytes: 2000 + (i % 60),
            emittedBytes: 2000 + (i % 60),
            matched: [],
            heldOut: true,
        })),
    ];
    expect(summarizeStats(rows).holdout.measuredSavedPct).toBeUndefined();
});

test("summarizeStats: high-volume cleaned commands with no cleaner surface as gaps, grouped by verb", () => {
    const rows = [
        // Two ad-hoc lines that share nothing but the command a handler would be written against.
        { command: "cd /work && weird-tool run --scope _editor", rawBytes: 9000, emittedBytes: 9000, matched: [], heldOut: false },
        { command: "weird-tool run --scope _sandbox | head -20", rawBytes: 3000, emittedBytes: 3000, matched: [], heldOut: false },
    ];
    // `commands` and `tokens` sum over all runs of the verb, not just its largest single run.
    expect(summarizeStats(rows).gaps).toEqual([{ command: "weird-tool", commands: 2, tokens: 3000 }]);
});

test("summarizeStats: a gap is weighed by what reached the model, not by what the cleaners already removed", () => {
    const rows = [
        // The cap ate 480 KB of this one: nothing is left for a handler to take.
        { command: "rg -n selectionBackground typings/", rawBytes: 488_000, emittedBytes: 180, matched: [], heldOut: false },
        { command: "git diff contract.lock.json | head -40", rawBytes: 146_000, emittedBytes: 96_000, matched: [], heldOut: false },
    ];
    expect(summarizeStats(rows).gaps).toEqual([{ command: "git diff", commands: 1, tokens: 24_000 }]);
});

test("summarizeStats: a deliberate file read is never a gap, but a computed report is", () => {
    const rows = [
        { command: "cat _sandbox/sandbox/src/git/ops/commit-message.ts", rawBytes: 26_000, emittedBytes: 26_000, matched: [], heldOut: false },
        { command: "cd /work && sed -n '120,270p' src/styles.css", rawBytes: 26_000, emittedBytes: 26_000, matched: [], heldOut: false },
        { command: "head -60 /root/.cache/webq/out/fly-io-docs.md", rawBytes: 26_000, emittedBytes: 26_000, matched: [], heldOut: false },
        { command: "cd /work && git show 3241dd07b -- src/schemas/devices.ts", rawBytes: 20_000, emittedBytes: 20_000, matched: [], heldOut: false },
        // `head` here is the pipeline's sink, not the command: the gap belongs to the search that filled it.
        { command: "cd /work && rg -n displayName _editor | head -30", rawBytes: 24_000, emittedBytes: 24_000, matched: [], heldOut: false },
    ];
    expect(summarizeStats(rows).gaps).toEqual([
        { command: "rg", commands: 1, tokens: 6000 },
        { command: "git show", commands: 1, tokens: 5000 },
    ]);
});

test("parseStatsFile: skips blank and corrupt lines", () => {
    expect(parseStatsFile('{"rawBytes":1}\n\nnot json\n{"rawBytes":2}\n')).toEqual([{ rawBytes: 1 }, { rawBytes: 2 }]);
});

// --- Per-conversation holdout and harm metric tests ---

test("summarizeStats: old rows without conversationHash still aggregate as before", () => {
    const rows = [
        { command: "pnpm i", rawBytes: 4000, emittedBytes: 400, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 3600 } },
        { command: "vitest", rawBytes: 8000, emittedBytes: 800, matched: ["test"], heldOut: false, stageBytes: { test: 6000, cap: 1200 } },
    ];
    const report = summarizeStats(rows);
    expect(report.commands).toBe(2);
    expect(report.savedPct).toBe(90);
    // No harm or arms when no conversationHash present.
    expect(report.harm).toBeUndefined();
    expect(report.arms).toBeUndefined();
});

test("summarizeHarm: retrieval within K is counted as a follow-up", () => {
    // 6 commands with unique verbs: none re-runs another's signature. Only run0.log was retrieved.
    const rows = Array.from({ length: 6 }, (_, i) => ({
        conversationHash: "abc", ts: i + 1, command: `unique-cmd-${i}`, rawBytes: 10000, emittedBytes: 2000,
        heldOut: false, stageBytes: { cap: 8000 }, runName: `run${i}.log`,
    }));
    const retrievals = [{ ts: 1000, runName: "run0.log" }];
    const harm = summarizeHarm(rows, retrievals, 5);
    expect(harm).not.toBeUndefined();
    const cap = harm.perStage.find((s) => s.id === "cap");
    expect(cap.trimmed).toBe(6);
    // Only the command whose run was retrieved counts as followed-up.
    expect(cap.followedUp).toBe(1);
});

test("summarizeHarm: re-run of same command signature within K is counted as a follow-up", () => {
    // 6 commands: each "pnpm build" is followed by an interleaving "cat" then another "pnpm build" within K=5.
    const rows = [];
    for (let i = 0; i < 6; i++) {
        rows.push({ conversationHash: "abc", ts: i * 2 + 1, command: "pnpm build", rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } });
        rows.push({ conversationHash: "abc", ts: i * 2 + 2, command: "cat file.ts", rawBytes: 100, emittedBytes: 100, heldOut: false, stageBytes: {} });
    }
    const harm = summarizeHarm(rows, [], 5);
    expect(harm).not.toBeUndefined();
    const cap = harm.perStage.find((s) => s.id === "cap");
    // All but the last pnpm build are followed by another pnpm build within K=5.
    expect(cap.followedUp).toBe(5);
    expect(cap.trimmed).toBe(6);
});

test("summarizeHarm: follow-up outside K is not counted", () => {
    // 7 "pnpm build" commands spaced far apart (each separated by 6 filler commands, beyond K=5).
    const rows = [];
    for (let i = 0; i < 7; i++) {
        rows.push({ conversationHash: "abc", ts: i * 7 + 1, command: "pnpm build", rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } });
        for (let j = 0; j < 6; j++) {
            rows.push({ conversationHash: "abc", ts: i * 7 + j + 2, command: `echo filler-${j}`, rawBytes: 10, emittedBytes: 10, heldOut: false, stageBytes: {} });
        }
    }
    const harm = summarizeHarm(rows, [], 5);
    expect(harm).not.toBeUndefined();
    const cap = harm.perStage.find((s) => s.id === "cap");
    // Every pnpm build is separated by 6 filler commands, so the next pnpm build is at position +7, outside K=5.
    expect(cap.followedUp).toBe(0);
    expect(cap.harmRate).toBe(0);
});

test("summarizeHarm: other conversation's commands do not count as follow-ups", () => {
    // Two conversations, each with exactly 5 unique commands. No command is re-run within its own conversation.
    // Both conversations run "pnpm build" but as the ONLY instance each — the other conversation's instance
    // must not count as a follow-up.
    const rows = [];
    for (let i = 0; i < 5; i++) {
        rows.push({ conversationHash: "abc", ts: i + 1, command: `unique-abc-${i}`, rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } });
    }
    for (let i = 0; i < 5; i++) {
        rows.push({ conversationHash: "xyz", ts: i + 1, command: `unique-xyz-${i}`, rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } });
    }
    const harm = summarizeHarm(rows, [], 5);
    expect(harm).not.toBeUndefined();
    const cap = harm.perStage.find((s) => s.id === "cap");
    // No command is ever re-run within its own conversation, so no follow-ups.
    expect(cap.followedUp).toBe(0);
});

test("summarizeHarm: another search with the same verb is not a re-run", () => {
    // `rg a` then `rg b`: one gap signature ("rg"), two different questions. Only the word-for-word repeat counts.
    const rows = ["rg alpha", "rg beta", "rg gamma", "rg delta", "rg epsilon", "rg  alpha"].map((command, i) => ({
        conversationHash: "abc", ts: i + 1, command, rawBytes: 9000, emittedBytes: 3000, heldOut: false, stageBytes: { search: 6000 },
    }));
    const search = summarizeHarm(rows, [], 5).perStage.find((stage) => stage.id === "search");
    expect(search.trimmed).toBe(6);
    // Only the first `rg alpha`, repeated (with other spacing) five commands later.
    expect(search.reRun).toBe(1);
    expect(search.followedUp).toBe(1);
});

test("summarizeHarm: a retrieval and a re-run of one command count it once, each reported on its own", () => {
    const rows = [
        { conversationHash: "abc", ts: 1, command: "pnpm build", runName: "r1", rawBytes: 9000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 7000 } },
        { conversationHash: "abc", ts: 2, command: "pnpm build", runName: "r2", rawBytes: 9000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 7000 } },
        ...[3, 4, 5].map((ts) => ({ conversationHash: "abc", ts, command: `make t${ts}`, runName: `r${ts}`, rawBytes: 9000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 7000 } })),
    ];
    const cap = summarizeHarm(rows, [{ runName: "r1" }], 5).perStage.find((stage) => stage.id === "cap");
    expect(cap).toMatchObject({ trimmed: 5, retrieved: 1, reRun: 1, followedUp: 1, harmRate: 0.2 });
});

test("summarizeHarm: the held-out conversations' own re-run share is the baseline", () => {
    const cleaned = Array.from({ length: 5 }, (_, i) => ({
        conversationHash: "c", ts: i + 1, command: `cmd ${i}`, rawBytes: 9000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 7000 },
    }));
    // Held out: `pnpm test` twice in a row (one re-run) among six commands.
    const held = ["pnpm test", "pnpm test", "ls", "cat a", "cat b", "git status"].map((command, i) => ({
        conversationHash: "h", ts: i + 1, command, rawBytes: 500, emittedBytes: 500, heldOut: true, stageBytes: {},
    }));
    const harm = summarizeHarm([...cleaned, ...held], [], 5);
    expect(harm.heldOutReRun).toEqual({ commands: 6, reRunRate: 0.167 });
});

test("summarizeHarm: small-n caveat present when fewer than 30 observations", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
        conversationHash: "abc", ts: i + 1, command: `cmd-${i}`, rawBytes: 5000, emittedBytes: 2000, heldOut: false,
        stageBytes: { cap: 3000 },
    }));
    const harm = summarizeHarm(rows, [], 5);
    expect(harm.caveat).toContain("fewer than 30");
});

test("summarizeHarm: returns undefined when no rows have conversationHash", () => {
    const rows = [
        { command: "pnpm build", rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } },
    ];
    expect(summarizeHarm(rows, [], 5)).toBeUndefined();
});

test("summarizeArms: compares per-conversation metrics for cleaned vs held-out", () => {
    const rows = [
        // 5 cleaned conversations
        ...Array.from({ length: 5 }, (_, i) => [
            { conversationHash: `c${i}`, ts: 1, command: "build", rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: { cap: 8000 } },
            { conversationHash: `c${i}`, ts: 2, command: "test", rawBytes: 5000, emittedBytes: 1000, heldOut: false, stageBytes: { test: 4000 } },
        ]).flat(),
        // 5 held-out conversations
        ...Array.from({ length: 5 }, (_, i) => [
            { conversationHash: `h${i}`, ts: 1, command: "build", rawBytes: 10000, emittedBytes: 10000, heldOut: true, stageBytes: {} },
            { conversationHash: `h${i}`, ts: 2, command: "test", rawBytes: 5000, emittedBytes: 5000, heldOut: true, stageBytes: {} },
        ]).flat(),
    ];
    const arms = summarizeArms(rows);
    expect(arms).not.toBeUndefined();
    expect(arms.cleaned.conversations).toBe(5);
    expect(arms.heldOut.conversations).toBe(5);
    expect(arms.cleaned.medianCommands).toBe(2);
    expect(arms.cleaned.medianEmittedBytes).toBe(3000);
    expect(arms.heldOut.medianEmittedBytes).toBe(15000);
});

test("summarizeArms: returns undefined with fewer than 5 conversations per arm", () => {
    const rows = [
        { conversationHash: "c0", ts: 1, command: "build", rawBytes: 10000, emittedBytes: 2000, heldOut: false, stageBytes: {} },
        { conversationHash: "h0", ts: 1, command: "build", rawBytes: 10000, emittedBytes: 10000, heldOut: true, stageBytes: {} },
    ];
    expect(summarizeArms(rows)).toBeUndefined();
});

// The signature is the command a handler is written against, so it has to survive the shapes agents actually type.
test("commandSignature: reads the signature through wrappers, pipelines and subcommands", () => {
    expect(commandSignature("cd /work/intentic && rg -n displayName _editor | head -30")).toBe("rg");
    expect(commandSignature("cd /work/intentic && git diff contract.lock.json | head -40")).toBe("git diff");
    expect(commandSignature("B=/history/engines/codex/bin/codex; strings -n 6 $B | sort -u")).toBe("strings");
    expect(commandSignature("sudo timeout 600 pnpm --filter @intentic/sandbox build")).toBe("pnpm");
    // `run` is `npx vitest`'s argument, not a second subcommand; the verb is what a cleaner matches.
    expect(commandSignature("npx vitest run src/agent")).toBe("npx vitest");
    // Not a subcommand verb: the second word is this run's question, and folding it in would make every run its own gap.
    expect(commandSignature("rg autoPicked --glob '!*.test.ts'")).toBe("rg");
    expect(commandSignature("/usr/local/bin/node -e 'console.log(1)'")).toBe("node");
    // A loop's closing keyword is a segment of its own; the command is what runs after it.
    expect(commandSignature('for i in $(seq 1 40); do echo "line $i"; done; seq 1 3000')).toBe("seq");
    expect(commandSignature("if [ -f x ]; then echo y; fi; pnpm test")).toBe("pnpm test");
});
