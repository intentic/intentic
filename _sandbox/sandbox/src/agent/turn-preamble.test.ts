import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { setupNoticeFor, SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { SPAWN_NOTE_HEADER } from "../children/spawn-note.js";
import { LITERAL_SLASH_NOTE, preambleNotes, stripTurnPreamble, unwrapStoredPrompt, withTurnPreamble } from "./turn-preamble.js";

const notice = `${SETUP_NOTICE_HEADER}\n(a dropped project arrives without them on purpose):\n- intentic: run \`pnpm install\` there first.`;
const note = `${SPAWN_NOTE_HEADER}\n\nThis sandbox can start full agents on any connected provider from your shell.`;

test("strip is the builder's inverse, for one note and for both", () => {
    expect(stripTurnPreamble(withTurnPreamble([notice], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note], "fix the bug"))).toBe("fix the bug");
    expect(stripTurnPreamble(withTurnPreamble([note, notice], "fix the bug"))).toBe("fix the bug");
});

// The whole point of the literal-slash note is positional: with it in front, the user's `/` is no longer the
// first thing the CLI's command parser sees. Restore then has to give the message back exactly as typed:
// including that leading slash, which is what the user wrote and what search and titles index.
test("the literal-slash note moves the user's `/` off the front, and strip puts it back", () => {
    const prompt = "/workspace view does not remember the file tree";
    const sent = withTurnPreamble([LITERAL_SLASH_NOTE], prompt);
    expect(sent.startsWith("/")).toBe(false);
    expect(stripTurnPreamble(sent)).toBe(prompt);
    expect(stripTurnPreamble(withTurnPreamble([note, notice, LITERAL_SLASH_NOTE], prompt))).toBe(prompt);
});

/* THE DEPENDENCY NOTICE HAS TWO OPENINGS, and for a long time only one of them was anchored, so this case is
 * built by calling the real builder rather than from a literal like the fixture above. A hand-written one would
 * have drifted exactly the way the two modules did: the stale half opens with its own sentence, the stripper
 * recognized nothing, and every restored message in this very workspace wore three lines about node_modules in
 * front of what the user actually typed. */
test("the stale-only notice (the shape this workspace itself produces) strips like every other", () => {
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

/* Two layers add notes now: honoured() for every runtime, then the harness arm on top (turn-plan.ts), and a
 * second separator would put the inner layer back in the user's bubble on restore. One separator, always. */
test("a second pass of notes merges into the first rather than nesting a separator", () => {
    const inner = withTurnPreamble([note], "fix the bug");
    const outer = withTurnPreamble([notice], inner);

    expect(outer.split("\n\n---\n\n")).toHaveLength(2);
    expect(outer.startsWith(SETUP_NOTICE_HEADER)).toBe(true);
    expect(outer).toContain(SPAWN_NOTE_HEADER);
    expect(stripTurnPreamble(outer)).toBe("fix the bug");
});

/* WHAT THE CHAT GETS TO SHOW: the other half of the strip, and the half that did not exist. Every assertion
 * below is really the same one: whatever came off the user's words is still reachable, whole, and labelled.
 *
 * These pair with the strip tests above deliberately. The two functions read one list and must answer about the
 * same span of text: a note the stripper cuts but the splitter cannot name is a note the user watches an agent
 * act on with no way to read it, which is the failure this whole mechanism exists to prevent. */
test("what strip removes, the split hands back: titled, whole, and in the order it was sent", () => {
    const sent = withTurnPreamble([note, notice], "fix the bug");

    expect(preambleNotes(sent)).toEqual([
        { title: "Spawning helper agents", text: note },
        { title: "Dependencies aren't installed yet", text: notice },
    ]);
    // …and the user's words are untouched by the disclosure, exactly as before it existed.
    expect(stripTurnPreamble(sent)).toBe("fix the bug");
});

// The two halves of the dependency notice are one string built by one function, and they say different things
// to different audiences, so they are two rows, not one, and the split has to find the second's opening.
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

// The disclosure obeys the same anchor the strip does. A user who quoted the notice themselves is not owed a
// row claiming the daemon sent it, and a header with no separator behind it is a boundary nobody can locate.
test("the split stays silent exactly where the strip declines to cut", () => {
    expect(preambleNotes("fix the bug")).toEqual([]);
    expect(preambleNotes(`My sessions get appended:\n\n${notice}\n\n---\n\nDespite dependencies being installed!`)).toEqual([]);
    expect(preambleNotes(notice)).toEqual([]);
});

/* THE TWO WRAPPERS NEST IN EITHER ORDER, which is the one thing a reader of a stored prompt cannot assume. The
 * daemon's own record keeps the turn's prompt, where a re-run's note is outermost; a provider's session store
 * keeps the prompt as it was SENT, where the preamble is. Both come back as the same three answers, or one of
 * the two stores hands a paragraph of machine prose back as something the user typed. */
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

// An ordinary prompt is neither, and unwrapping is what every reader runs on every message, so it has to hand
// back exactly what it was given rather than finding structure that is not there.
test("an ordinary prompt unwraps to itself", () => {
    expect(unwrapStoredPrompt("fix the bug")).toEqual({ text: "fix the bug", notes: [] });
});
