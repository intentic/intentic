import { unspokenPromptRow } from "./agent-words.js";
import {
    allowedWords,
    answerLostWords,
    asChildNews,
    childNewsOf,
    driftWords,
    fellBackWords,
    landConflictWords,
    landedWords,
    linkedQuestionWords,
    messageLostWords,
    movedHereWords,
    notStartedWords,
    otherModelWords,
    questionWords,
    restartedWords,
    stoppedWords,
    workingWords,
} from "./child-news.js";

const who = { child: "sub-moon-4rfr", title: "#2 Targeted memory reclaim instead of global drop_caches" };

// The runner's own failure, word for word as runner-dispatch.ts says it: the news that drew four of the owner's bubbles.
const FAILURE =
    "Preparing the runner's workspace failed: the runner \"omen\" runs an older build (0.0.0), whose sync can lose a turn's uncommitted work, so nothing was sent there. Update it (Devices, its Update button), or move this conversation here to go on in this sandbox.";

describe("news about a subagent", () => {
    // 2026-11-26: the sentence as the owner's chat held it, before it was composed here; records keep it so.
    it("reads the words a parent was told before they were composed here", () => {
        const stored = `Your subagent \`sub-moon-4rfr\` ("#2 Targeted memory reclaim instead of global drop_caches") could not start on the runner "omen": ${FAILURE} It runs here, in this sandbox, instead, and its report reaches you when it ends.`;
        expect(movedHereWords(who, "omen", FAILURE)).toBe(stored);
        expect(childNewsOf(stored)).toEqual({ kind: "movedHere", from: "sub-moon-4rfr", title: who.title, runner: "omen", cause: FAILURE, sent: stored });
    });

    // Composer and parser are one piece of knowledge: every sentence reads back as the kind it was written as.
    it.each([
        ["stopped", stoppedWords(who, "its allowance never reopened."), { cause: "its allowance never reopened." }],
        ["restarted", restartedWords(who), {}],
        ["otherModel", otherModelWords(who, "kimi-k3", "kimi-k3-256k"), { model: "kimi-k3" }],
        ["fellBack", fellBackWords(who, "claude/opus", "codex/gpt-6", "429: allowance spent"), { model: "codex/gpt-6", cause: "429: allowance spent" }],
        ["working", workingWords(who, "the sandbox sent its turn again by itself because its allowance reopened"), { cause: "the sandbox sent its turn again by itself because its allowance reopened" }],
        ["question", questionWords(who, [{ question: "Which cache?", options: [{ label: "page" }, { label: "slab" }] }]), { cause: "Which cache?" }],
        ["landed", landedWords(who, ["intentic"]), {}],
        ["landConflict", landConflictWords(who, ["a.ts", "b.ts"]), {}],
        ["drift", driftWords(who, "`intentic` moved 3 commits."), { cause: "`intentic` moved 3 commits." }],
    ] as const)("reads %s back with its subagent and what it carries", (kind, prompt, carried) => {
        expect(childNewsOf(prompt)).toEqual({ kind, from: who.child, title: who.title, ...carried, sent: prompt });
    });

    it.each([
        ["notStarted", notStartedWords("sub-x7", "the owner declined it."), { cause: "the owner declined it." }],
        ["allowed", allowedWords("sub-x7", "It runs on omen."), {}],
        ["messageLost", messageLostWords("sub-x7", "it is archived."), { cause: "it is archived." }],
        ["answerLost", answerLostWords("sub-x7", "it is not waiting on a question."), { cause: "it is not waiting on a question." }],
        ["question", linkedQuestionWords("sub-x7", "acme", [{ question: "Ship it?", options: [] }]), { cause: "Ship it?" }],
    ] as const)("reads %s, which names no title, back with its subagent", (kind, prompt, carried) => {
        expect(childNewsOf(prompt)).toEqual({ kind, from: "sub-x7", ...carried, sent: prompt });
    });

    it("ends a title where the fixed words after it begin, whatever quotes or brackets it holds", () => {
        const odd = { child: "sub-tuna-25dq", title: 'Propose a "WSL" VM size (card")' };
        expect(childNewsOf(restartedWords(odd))).toMatchObject({ kind: "restarted", title: odd.title });
        expect(childNewsOf(restartedWords({ child: "sub-tuna-25dq" }))).not.toHaveProperty("title");
    });

    it("is not news when a prompt only mentions a subagent", () => {
        expect(childNewsOf("Your subagent `sub-x7` looks stuck, can you check?")).toBeUndefined();
        expect(childNewsOf("Report from a subagent you started: `sub-x7` finished.\n\nDone.")).toBeUndefined();
    });

    it("is a notice wherever a prompt becomes a row, never the owner's words", () => {
        const prompt = restartedWords(who);
        expect(unspokenPromptRow(prompt)).toMatchObject({ role: "notice", childNews: { kind: "restarted", from: who.child } });
    });

    it("reads a row recorded as the user's as the news it was, keeping its place and moment", () => {
        const text = stoppedWords(who, "no fallback took it.");
        const read = asChildNews({ role: "user", text, rowId: "r1", run: "run-1", sentAt: 1000, speaker: { kind: "sandbox" } });
        expect(read).toMatchObject({ role: "notice", rowId: "r1", run: "run-1", openedAt: 1000, childNews: { kind: "stopped" } });
        expect(read).not.toHaveProperty("speaker");
        expect(read).not.toHaveProperty("sentAt");
    });

    it("leaves a person's own words alone, even word for word the same", () => {
        const row = { role: "user" as const, text: restartedWords(who), speaker: { kind: "person" as const, email: "a@b.c" } };
        expect(asChildNews(row)).toBe(row);
        const plain = { role: "user" as const, text: "hello" };
        expect(asChildNews(plain)).toBe(plain);
    });
});
