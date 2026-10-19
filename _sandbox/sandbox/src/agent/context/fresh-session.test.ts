import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../../conversations/registry/agents-store.testing.js";
import { preambleNotes } from "../../sessions/vocabulary/prompt-envelope.js";
import { type FreshScope, freshFactsIfAny, freshNote, freshRefusal, freshReviewInstructions, rangeCommand } from "./fresh-session.js";

// A fresh session on another conversation's work: whether one may open, and the words it is told the work is.

const ORIGIN = isolatedAgent([{ repo: "root", base: "a".repeat(40) }], { id: "origin-1" });
const entries = (...list: readonly PersistedAgent[]) => (id: string) => list.find((entry) => entry.id === id);

describe("whether a fresh session may open", () => {
    const freshOf = { conversationId: "origin-1", kind: "review" } as const;

    it("opens as a new conversation on a live origin with a copy of its own", () => {
        expect(freshRefusal(entries(ORIGIN), "review-1", freshOf)).toBeUndefined();
    });

    it("refuses a conversation that already exists, an origin that does not, and one filed away", () => {
        expect(freshRefusal(entries(ORIGIN, conversationEntry({ id: "review-1" })), "review-1", freshOf)).toMatch(/already exists/u);
        expect(freshRefusal(entries(), "review-1", freshOf)).toMatch(/no conversation "origin-1"/u);
        expect(freshRefusal(entries({ ...ORIGIN, archivedAt: 5 }), "review-1", freshOf)).toMatch(/archived/u);
    });

    // A retry after an answer that never arrived is the same opening sent again, which the queue answers as a resend.
    it("lets the same opening through again once its entry latched that origin", () => {
        const opened = conversationEntry({ id: "review-1", identity: { startedBy: "agent:origin-1", fresh: { of: "origin-1", kind: "review", at: 1 } } });
        expect(freshRefusal(entries(ORIGIN, opened), "review-1", freshOf)).toBeUndefined();
        expect(freshRefusal(entries(ORIGIN, opened), "review-1", { conversationId: "elsewhere", kind: "review" })).toMatch(/already exists/u);
    });

    it("refuses an origin in the shared workspace, on another machine, or with no work yet", () => {
        expect(freshRefusal(entries(conversationEntry({ id: "origin-1" })), "review-1", freshOf)).toMatch(/shared workspace/u);
        expect(freshRefusal(entries({ ...ORIGIN, placement: { ...ORIGIN.placement, runner: "laptop" } }), "review-1", freshOf)).toMatch(/another machine/u);
        expect(freshRefusal(entries({ ...ORIGIN, placement: { ...ORIGIN.placement, repos: [] } }), "review-1", freshOf)).toMatch(/no work yet/u);
    });
});

describe("what a fresh session is told", () => {
    const scope: FreshScope = {
        origin: { id: "origin-1", title: "Add rate limits" },
        kind: "review",
        cut: true,
        ranges: [
            { repo: "root", from: "1234567890abcdef1234" },
            { repo: "intentic", from: "fedcba0987654321fedc" },
        ],
    };

    it("reads each range from the checkout's root, a nested repo through -C", () => {
        expect(rangeCommand({ repo: "root", from: "1234567890abcdef1234" })).toBe("git diff 1234567890ab...HEAD");
        expect(rangeCommand({ repo: "intentic", from: "fedcba0987654321fedc" })).toBe("git -C intentic diff fedcba098765...HEAD");
    });

    it("names the origin and the ranges, says what the changes mean here, and that findings go back only when sent", () => {
        const { text } = freshNote(scope);
        expect(text).toContain('`origin-1` ("Add rate limits")');
        expect(text).toContain("- `git diff 1234567890ab...HEAD` (the workspace root)");
        expect(text).toContain("- `git -C intentic diff fedcba098765...HEAD`");
        expect(text).toContain("not `@{upstream}`");
        expect(text).toContain("review these ranges and nothing else");
        expect(text).toContain("unless the person you are working with sends it there");
    });

    // The note rides the preamble ahead of the person's words, so a `/code-review` typed after it still reads as the
    // command, and the transcript shows the note as a note rather than as typing.
    it("is parsed back out of the preamble as its own note", () => {
        const note = freshNote(scope);
        const notes = preambleNotes(`${note.text}\n\n---\n\n/code-review`);
        expect(notes.map((each) => each.title)).toContain(note.title);
    });

    it("says there is nothing to read when the origin changed nothing, and that the work is missing when it was not cut", () => {
        expect(freshNote({ ...scope, ranges: [] }).text).toContain("changed nothing yet");
        expect(freshNote({ ...scope, ranges: [] }).text).not.toContain("review these ranges");
        expect(freshNote({ ...scope, cut: false }).text).toContain("could not be copied here");
    });

    it("hands Codex's reviewer the ranges, and nothing when there is no work to review", () => {
        expect(freshReviewInstructions(scope)).toBe(
            [
                "Review the code changes in these ranges, each run from the checkout's root:",
                "- `git diff 1234567890ab...HEAD` (the workspace root)",
                "- `git -C intentic diff fedcba098765...HEAD`",
                "They are the work this session was opened on. Review only these changes.",
            ].join("\n"),
        );
        expect(freshReviewInstructions({ ...scope, ranges: [] })).toBeUndefined();
        expect(freshReviewInstructions({ ...scope, cut: false })).toBeUndefined();
    });
});

describe("a fresh session's turn facts", () => {
    const deps = (...list: readonly PersistedAgent[]) => ({
        agents: { entry: entries(...list) },
        // SAFETY: never reached: an origin this fresh session was not cut from is not read, so no method of it is called.
        agentWorktrees: {} as never,
        logger: { warn: () => undefined },
    });
    const fresh = isolatedAgent([{ repo: "root", base: "b".repeat(40) }], {
        id: "review-1",
        identity: { startedBy: "agent:origin-1", fresh: { of: "origin-1", kind: "review", at: 1 } },
    });

    it("are none for a conversation that is no fresh session", async () => {
        expect(await freshFactsIfAny(deps(ORIGIN), "origin-1", ORIGIN, 0)).toBeUndefined();
    });

    it("carry the note on the opening turn and after a compaction only, and no review scope without the cut", async () => {
        expect(await freshFactsIfAny(deps(ORIGIN, fresh), "review-1", fresh, 0)).toEqual({ note: expect.objectContaining({ title: "The work this session started from" }) });
        expect(await freshFactsIfAny(deps(ORIGIN, fresh), "review-1", fresh, 2)).toEqual({});
        expect(await freshFactsIfAny(deps(ORIGIN, fresh), "review-1", { ...fresh, compactedTurn: 1 }, 2)).toHaveProperty("note");
    });
});
