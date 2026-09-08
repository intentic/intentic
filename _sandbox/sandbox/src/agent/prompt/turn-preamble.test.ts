import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { setupNoticeFor, SETUP_NOTICE_HEADER } from "../../workspace/layout/workspace-setup.js";
import { SPAWN_NOTE_HEADER } from "../subagents/spawn-note.js";
import { SKILL_CATALOG_NOTE_HEADER, SKILL_CATALOG_NOTE_TITLE } from "../../settings/loaded-skills.js";
import { LITERAL_SLASH_NOTE, preambleNotes, stripTurnPreamble, unwrapStoredPrompt, withTurnPreamble } from "./turn-preamble.js";

const notice = `${SETUP_NOTICE_HEADER}\n(a dropped project arrives without them on purpose):\n- intentic: run \`pnpm install\` there first.`;
const note = `${SPAWN_NOTE_HEADER}\n\nThis sandbox can start full agents on any connected provider from your shell.`;

test("strip is the builder's inverse, for one note and for both", () => {
    expect(stripTurnPreamble(withTurnPreamble([notice], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note, notice], "fix the bug"))).toBe("fix the bug");
});

test("the generated skill catalogue strips from provider history and keeps its disclosure title", () => {
    const catalogue = `${SKILL_CATALOG_NOTE_HEADER}\n\n- **quill** → \`${WORKSPACE_ROOT}/.agents/skills/quill/SKILL.md\``;
    const prompt = withTurnPreamble([catalogue], "draw one");

    expect(stripTurnPreamble(prompt)).toBe("draw one");
    expect(preambleNotes(prompt)).toEqual([{ title: SKILL_CATALOG_NOTE_TITLE, text: catalogue }]);
});

test("the literal-slash note moves the user's `/` off the front, and strip puts it back", () => {
    const prompt = "/workspace view does not remember the file tree";
    const sent = withTurnPreamble([LITERAL_SLASH_NOTE.text], prompt);
    expect(sent.startsWith("/")).toBe(false);
    expect(stripTurnPreamble(sent)).toBe(prompt);
    expect(stripTurnPreamble(withTurnPreamble([note, notice, LITERAL_SLASH_NOTE.text], prompt))).toBe(prompt);
});

test("the stale-only notice (the shape this workspace itself produces) strips like every other", () => {
    const stale = setupNoticeFor([
        {
            dir: "intentic",
            recipe: { ecosystem: "node", manager: "pnpm", command: "pnpm install", evidence: "pnpm-lock.yaml", marker: "node_modules" },
            state: "stale",
            unresolved: [{ dir: "", names: ["vue", "zod"] }],
        },
    ]);

    expect(stale).toEqual(expect.any(String));
    expect(stale).not.toContain(SETUP_NOTICE_HEADER);
    expect(stripTurnPreamble(withTurnPreamble([stale ?? ""], `Say "hello"`))).toBe(`Say "hello"`);
});

test("no notes ⇒ the prompt rides untouched, and strip leaves ordinary messages alone", () => {
    expect(withTurnPreamble([], "fix the bug")).toBe("fix the bug");
    expect(stripTurnPreamble("fix the bug")).toBe("fix the bug");
});

test("a user quoting the notice mid-message keeps their text: strip anchors on the START", () => {
    const quoted = `My sessions get appended:\n\n${notice}\n\n---\n\nDespite dependencies being installed!`;
    expect(stripTurnPreamble(quoted)).toBe(quoted);
});

test("only the FIRST separator is consumed: a prompt containing --- survives", () => {
    const prompt = "intro\n\n---\n\noutro";
    expect(stripTurnPreamble(withTurnPreamble([notice], prompt))).toBe(prompt);
});

test("a message that starts with a header but has no separator is left alone", () => {
    expect(stripTurnPreamble(notice)).toBe(notice);
});

// Two real layers add notes (honoured() per runtime, then turn-plan.ts's harness arm on top); nesting must never double
// the separator.
test("a second pass of notes merges into the first rather than nesting a separator", () => {
    const inner = withTurnPreamble([note], "fix the bug");
    const outer = withTurnPreamble([notice], inner);

    expect(outer.split("\n\n---\n\n")).toHaveLength(2);
    expect(outer.startsWith(SETUP_NOTICE_HEADER)).toBe(true);
    expect(outer).toContain(SPAWN_NOTE_HEADER);
    expect(stripTurnPreamble(outer)).toBe("fix the bug");
});

test("what strip removes, the split hands back: titled, whole, and in the order it was sent", () => {
    const sent = withTurnPreamble([note, notice], "fix the bug");

    expect(preambleNotes(sent)).toEqual([
        { title: "Spawning child agents", text: note },
        { title: "Dependencies aren't installed yet", text: notice },
    ]);
    expect(stripTurnPreamble(sent)).toBe("fix the bug");
});

// The notice is one string with two openings; the split has to find where the second begins.
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

test("the split stays silent exactly where the strip declines to cut", () => {
    expect(preambleNotes("fix the bug")).toEqual([]);
    expect(preambleNotes(`My sessions get appended:\n\n${notice}\n\n---\n\nDespite dependencies being installed!`)).toEqual([]);
    expect(preambleNotes(notice)).toEqual([]);
});

// Nesting order differs by store: the daemon's own record has the re-run note outermost, a provider's session store has
// the preamble outermost.
test("a re-run unwraps the same whichever way its note and the preamble are nested", () => {
    const sent = withTurnPreamble([notice], withResumeNote("fix the bug", RESUME_NOTES.auth));
    const recorded = withResumeNote(withTurnPreamble([notice], "fix the bug"), RESUME_NOTES.auth);

    for (const stored of [sent, recorded]) {
        const unwrapped = unwrapStoredPrompt(stored);
        expect(unwrapped.text).toBe("fix the bug");
        expect(unwrapped.notes).toMatchObject([{ title: "Dependencies aren't installed yet" }]);
        expect(unwrapped.resume).toMatchObject({ kind: "notice" });
    }
});

// Unwrapping runs on every message, so it must return unstructured text unchanged.
test("an ordinary prompt unwraps to itself", () => {
    expect(unwrapStoredPrompt("fix the bug")).toEqual({ text: "fix the bug", notes: [] });
});
