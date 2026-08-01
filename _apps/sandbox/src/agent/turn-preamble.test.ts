import { expect, test } from "vitest";
import type { RepoSync } from "../agents/sync.js";
import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";
import { LITERAL_SLASH_NOTE, stripTurnPreamble, SYNC_NOTE_HEADER, syncNote, withTurnPreamble } from "./turn-preamble.js";

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

const behind = (overrides: Partial<RepoSync> = {}): RepoSync => ({
    repo: "root",
    onto: "abc1234",
    commits: 3,
    moved: ["src/app.ts", "src/other.ts"],
    overlap: ["src/app.ts"],
    ...overrides,
});

test("an up-to-date branch has nothing to say", () => {
    expect(syncNote([])).toBeUndefined();
});

// The overlap is the note's reason to exist: what the agent had also edited is the re-check instruction, and
// the rest of main's movement is a count so it doesn't drown that out.
test("the sync note names what the agent had also changed and counts the rest", () => {
    const text = syncNote([behind()]) ?? "";

    expect(text.startsWith(SYNC_NOTE_HEADER)).toBe(true);
    expect(text).toContain("3 commits now sit underneath your work");
    expect(text).toContain("- src/app.ts");
    expect(text).not.toContain("- src/other.ts");
    expect(text).toContain("1 other file moved too");
    expect(text).toContain("does not mean the result still builds");
});

// A nested repo's paths are ambiguous on their own — the same qualification the review rows use.
test("a nested repo's paths carry the repo that disambiguates them", () => {
    expect(syncNote([behind({ repo: "intentic", overlap: ["src/app.ts"] })])).toContain("- intentic/src/app.ts");
});

test("a rolled-back rebase tells the agent the land will refuse, and why it is not its doing", () => {
    const text = syncNote([behind({ blocked: true })]) ?? "";

    expect(text).toContain("would NOT apply in root");
    expect(text).toContain("still on its old base");
    expect(text).toContain("not something you did");
    // Nothing moved, so nothing claims to have been replayed.
    expect(text).not.toContain("now sit underneath your work");
});

test("a composition can be half synced and half blocked, and says both", () => {
    const text = syncNote([behind(), behind({ repo: "intentic", blocked: true, commits: 2 })]) ?? "";

    expect(text).toContain("3 commits now sit underneath your work");
    expect(text).toContain("would NOT apply in intentic");
});
