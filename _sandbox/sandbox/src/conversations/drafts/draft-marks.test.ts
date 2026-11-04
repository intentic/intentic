import { clearIn, type DraftsFile, writeIn } from "./composer-drafts.js";
import { dropMarksIn, markedBy, markIn, marksIn, type MarkStep } from "./draft-marks.js";

// The rules a mark on a conversation not started yet is kept by, as pure steps over the drafts file: whose it is, what a
// press settles to, the cap, and that the words beside it never move it.

const EMPTY: DraftsFile = { revision: 0, people: {} };
const ADA = "ada@example.com";
const BOB = "bob@example.com";
const CAP = 3;

const stepped = (step: MarkStep): DraftsFile => {
    if ("full" in step) {
        throw new Error("the press was refused as over the cap");
    }
    return step.file;
};
const pressed = (file: DraftsFile, person: string, emoji: string, on: boolean, at = 1000, name?: string): DraftsFile =>
    stepped(markIn(file, person, "conv-1", { emoji, name, on }, at, CAP));

describe("markIn", () => {
    test("a press puts the person's mark on the conversation, with the name their sign-in carried and when", () => {
        const step = markIn(EMPTY, ADA, "conv-1", { emoji: "👍", name: "Ada", on: true }, 1000, CAP);
        expect(step).toEqual({ file: { ...EMPTY, marks: { [ADA]: { "conv-1": [{ emoji: "👍", name: "Ada", at: 1000 }] } } }, marks: [{ emoji: "👍", name: "Ada", at: 1000 }], changed: true });
    });

    test("a press already where it asks changes nothing, so a double press lands where one did", () => {
        const once = pressed(EMPTY, ADA, "👍", true);
        const again = markIn(once, ADA, "conv-1", { emoji: "👍", on: true }, 2000, CAP);
        expect(again).toEqual({ file: once, marks: [{ emoji: "👍", at: 1000 }], changed: false });
        expect(markIn(EMPTY, ADA, "conv-1", { emoji: "👍", on: false }, 2000, CAP)).toEqual({ file: EMPTY, marks: [], changed: false });
    });

    test("taking back the last mark leaves no key behind", () => {
        expect(pressed(pressed(EMPTY, ADA, "👍", true), ADA, "👍", false)).toEqual(EMPTY);
    });

    test("a new kind past the cap is refused, while a kind already there still takes its press back", () => {
        const full = pressed(pressed(pressed(EMPTY, ADA, "👍", true), ADA, "🎉", true), ADA, "🚀", true);
        expect(markIn(full, ADA, "conv-1", { emoji: "👀", on: true }, 2000, CAP)).toEqual({ full: true });
        expect(marksIn(pressed(full, ADA, "🎉", false), ADA, "conv-1").map((mark) => mark.emoji)).toEqual(["👍", "🚀"]);
    });

    test("each person's marks are their own", () => {
        const both = pressed(pressed(EMPTY, ADA, "👍", true), BOB, "🎉", true, 2000);
        expect(markedBy(both, ADA)).toEqual({ "conv-1": [{ emoji: "👍", by: [{ email: ADA, at: 1000 }] }] });
        expect(markedBy(both, BOB)).toEqual({ "conv-1": [{ emoji: "🎉", by: [{ email: BOB, at: 2000 }] }] });
        expect(markedBy(pressed(both, BOB, "🎉", false), ADA)).toEqual(markedBy(both, ADA));
    });
});

describe("the words beside the marks", () => {
    test("writing, emptying and clearing the person's draft never moves their marks", () => {
        const marked = pressed(EMPTY, ADA, "👍", true);
        const written = writeIn(marked, ADA, { id: "conv-1", text: "fix the login" }, 1000).file;
        const emptied = writeIn(written, ADA, { id: "conv-1", text: "", base: 1 }, 2000).file;
        const cleared = clearIn(writeIn(emptied, ADA, { id: "conv-1", text: "again" }, 3000).file, ADA, "conv-1", undefined).file;
        for (const file of [written, emptied, cleared]) {
            expect(marksIn(file, ADA, "conv-1")).toEqual([{ emoji: "👍", at: 1000 }]);
        }
    });
});

describe("dropMarksIn", () => {
    test("forgets one person's marks on one conversation, and is the same file when there were none", () => {
        const both = pressed(pressed(EMPTY, ADA, "👍", true), BOB, "🎉", true);
        const dropped = dropMarksIn(both, ADA, "conv-1");
        expect([marksIn(dropped, ADA, "conv-1"), marksIn(dropped, BOB, "conv-1").length]).toEqual([[], 1]);
        expect(dropMarksIn(dropped, ADA, "conv-1")).toBe(dropped);
    });
});
