import { expect, test } from "vitest";
import type { RepoSync } from "../agents/sync.js";
import { setupNoticeFor, SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";
import {
    LITERAL_SLASH_NOTE,
    preambleNotes,
    splitTurnNotes,
    stripTurnPreamble,
    SYNC_NOTE_HEADER,
    syncNote,
    withTurnPreamble,
} from "./turn-preamble.js";

const notice = `${SETUP_NOTICE_HEADER}\n(a dropped project arrives without them on purpose):\n- intentic: run \`pnpm install\` there first.`;
const note = `${DELEGATION_NOTE_HEADER}\n\nThe user's connected agent accounts are runnable from your shell.`;

test("strip is the builder's inverse, for one note and for both", () => {
    expect(stripTurnPreamble(withTurnPreamble([notice], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note, notice], "fix the bug"))).toBe("fix the bug");
});

// The whole point of the literal-slash note is positional: with it in front, the user's `/` is no longer the
// first thing the CLI's command parser sees. Restore then has to give the message back exactly as typed —
// including that leading slash, which is what the user wrote and what search and titles index.
test("the literal-slash note moves the user's `/` off the front, and strip puts it back", () => {
    const prompt = "/workspace view does not remember the file tree";
    const sent = withTurnPreamble([LITERAL_SLASH_NOTE], prompt);
    expect(sent.startsWith("/")).toBe(false);
    expect(stripTurnPreamble(sent)).toBe(prompt);
    expect(stripTurnPreamble(withTurnPreamble([note, notice, LITERAL_SLASH_NOTE], prompt))).toBe(prompt);
});

/* THE DEPENDENCY NOTICE HAS TWO OPENINGS, and for a long time only one of them was anchored — so this case is
 * built by calling the real builder rather than from a literal like the fixture above. A hand-written one would
 * have drifted exactly the way the two modules did: the stale half opens with its own sentence, the stripper
 * recognized nothing, and every restored message in this very workspace wore three lines about node_modules in
 * front of what the user actually typed. */
test("the stale-only notice — the shape this workspace itself produces — strips like every other", () => {
    const stale = setupNoticeFor([
        {
            dir: "intentic",
            recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
            state: "stale",
            unresolved: [{ dir: "", names: ["vue", "zod"] }],
        },
    ]);

    expect(stale).toBeDefined();
    expect(stale).not.toContain(SETUP_NOTICE_HEADER);
    expect(stripTurnPreamble(withTurnPreamble([stale ?? ""], `Say "hello"`))).toBe(`Say "hello"`);
});

test("no notes ⇒ the prompt rides untouched, and strip leaves ordinary messages alone", () => {
    expect(withTurnPreamble([], "fix the bug")).toBe("fix the bug");
    expect(stripTurnPreamble("fix the bug")).toBe("fix the bug");
});

test("a user quoting the notice mid-message keeps their text — strip anchors on the START", () => {
    const quoted = `My sessions get appended:\n\n${notice}\n\n---\n\nDespite dependencies being installed!`;
    expect(stripTurnPreamble(quoted)).toBe(quoted);
});

test("only the FIRST separator is consumed — a prompt containing --- survives", () => {
    const prompt = "intro\n\n---\n\noutro";
    expect(stripTurnPreamble(withTurnPreamble([notice], prompt))).toBe(prompt);
});

test("a message that starts with a header but has no separator is left alone", () => {
    expect(stripTurnPreamble(notice)).toBe(notice);
});

/* Two layers add notes now — honoured() for every runtime, then the harness arm on top (turn-plan.ts) — and a
 * second separator would put the inner layer back in the user's bubble on restore. One separator, always. */
test("a second pass of notes merges into the first rather than nesting a separator", () => {
    const inner = withTurnPreamble([note], "fix the bug");
    const outer = withTurnPreamble([notice], inner);

    expect(outer.split("\n\n---\n\n")).toHaveLength(2);
    expect(outer.startsWith(SETUP_NOTICE_HEADER)).toBe(true);
    expect(outer).toContain(DELEGATION_NOTE_HEADER);
    expect(stripTurnPreamble(outer)).toBe("fix the bug");
});

/* WHAT THE CHAT GETS TO SHOW — the other half of the strip, and the half that did not exist. Every assertion
 * below is really the same one: whatever came off the user's words is still reachable, whole, and labelled.
 *
 * These pair with the strip tests above deliberately. The two functions read one list and must answer about the
 * same span of text — a note the stripper cuts but the splitter cannot name is a note the user watches an agent
 * act on with no way to read it, which is the failure this whole mechanism exists to prevent. */
test("what strip removes, the split hands back — titled, whole, and in the order it was sent", () => {
    const sent = withTurnPreamble([note, notice], "fix the bug");

    expect(preambleNotes(sent)).toEqual([
        { title: "Delegating to other coding agents", text: note },
        { title: "Dependencies aren't installed yet", text: notice },
    ]);
    // …and the user's words are untouched by the disclosure, exactly as before it existed.
    expect(stripTurnPreamble(sent)).toBe("fix the bug");
});

// The two halves of the dependency notice are one string built by one function, and they say different things
// to different audiences — so they are two rows, not one, and the split has to find the second's opening.
test("the dependency notice's two halves come back as two rows", () => {
    const both =
        setupNoticeFor([
            {
                dir: "",
                recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
                state: "needs-setup",
            },
            {
                dir: "intentic",
                recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
                state: "stale",
                unresolved: [{ dir: "", names: ["vue"] }],
            },
        ]) ?? "";

    expect(preambleNotes(withTurnPreamble([both], "go"))).toMatchObject([
        { title: "Dependencies aren't installed yet" },
        { title: "Dependencies are behind" },
    ]);
});

// The mid-turn rebase is handed the note directly rather than a built prompt — there is no user message for it
// to sit in front of — so the splitter has to title a bare note on its own.
test("a bare note titles itself, which is what the mid-turn rebase discloses", () => {
    expect(splitTurnNotes(syncNote([behind()], "parked") ?? "")).toMatchObject([{ title: "Your workspace moved on underneath this agent" }]);
});

// The disclosure obeys the same anchor the strip does. A user who quoted the notice themselves is not owed a
// row claiming the daemon sent it, and a header with no separator behind it is a boundary nobody can locate.
test("the split stays silent exactly where the strip declines to cut", () => {
    expect(preambleNotes("fix the bug")).toEqual([]);
    expect(preambleNotes(`My sessions get appended:\n\n${notice}\n\n---\n\nDespite dependencies being installed!`)).toEqual([]);
    expect(preambleNotes(notice)).toEqual([]);
});

const behind = (overrides: Partial<RepoSync> = {}): RepoSync => ({
    repo: "root",
    onto: "abc1234",
    commits: 3,
    moved: ["src/app.ts", "src/other.ts"],
    overlap: ["src/app.ts"],
    ...overrides,
});

test("an up-to-date branch has nothing to say", () => {
    expect(syncNote([], "start")).toBeUndefined();
});

// The overlap is the note's reason to exist: what the agent had also edited is the re-check instruction, and
// the rest of main's movement is a count so it doesn't drown that out.
test("the sync note names what the agent had also changed and counts the rest", () => {
    const text = syncNote([behind()], "start") ?? "";

    expect(text.startsWith(SYNC_NOTE_HEADER)).toBe(true);
    expect(text).toContain("3 commits now sit underneath your work");
    expect(text).toContain("- src/app.ts");
    expect(text).not.toContain("- src/other.ts");
    expect(text).toContain("1 other file moved too");
    expect(text).toContain("does not mean the result still builds");
});

// A nested repo's paths are ambiguous on their own — the same qualification the review rows use.
test("a nested repo's paths carry the repo that disambiguates them", () => {
    expect(syncNote([behind({ repo: "intentic", overlap: ["src/app.ts"] })], "start")).toContain("- intentic/src/app.ts");
});

test("a rolled-back rebase tells the agent the land will refuse, and why it is not its doing", () => {
    const text = syncNote([behind({ blocked: true })], "start") ?? "";

    expect(text).toContain("would NOT apply in root");
    expect(text).toContain("still on its old base");
    expect(text).toContain("not something you did");
    // Nothing moved, so nothing claims to have been replayed.
    expect(text).not.toContain("now sit underneath your work");
});

test("a composition can be half synced and half blocked, and says both", () => {
    const text = syncNote([behind(), behind({ repo: "intentic", blocked: true, commits: 2 })], "start") ?? "";

    expect(text).toContain("3 commits now sit underneath your work");
    expect(text).toContain("would NOT apply in intentic");
});

/* The parked note addresses an agent whose reads are MINUTES old rather than turns old, so the instruction is
 * the sharper one: what you read before you asked will now be rejected as a stale anchor. Same three facts,
 * different standing — a note that told a mid-turn agent to "check what you remember about this tree" would be
 * describing the wrong problem. */
test("the note taken while parked on a card says the reads just went stale, not that memory might be", () => {
    const text = syncNote([behind()], "parked") ?? "";

    expect(text).toContain("while you were waiting for their answer");
    expect(text).toContain("just rebased");
    expect(text).toContain("stale read");
    expect(text).toContain("REJECTED");
    // The overlap instruction is the note's point at either moment, so it survives the change of address.
    expect(text).toContain("- src/app.ts");
});

// Both moments carry the same three facts; only the sentence that places them in time differs.
test("either moment reports the same movement, blocks and counts", () => {
    const parked = syncNote([behind(), behind({ repo: "intentic", blocked: true, commits: 2 })], "parked") ?? "";

    expect(parked).toContain("3 commits now sit underneath your work");
    expect(parked).toContain("would NOT apply in intentic");
    expect(parked).toContain("1 other file moved too");
});
