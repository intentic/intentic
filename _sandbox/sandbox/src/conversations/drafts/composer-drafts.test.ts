import { clearIn, type DraftsFile, draftsOf, heldSinceIn, writeIn } from "./composer-drafts.js";

// The rules a draft is kept by, as pure steps over the file: whose it is, which revision a write or a clear may act on,
// and what a card reads of it.

const EMPTY: DraftsFile = { revision: 0, people: {} };
const ADA = "ada@example.com";
const BOB = "bob@example.com";

const written = (file: DraftsFile, person: string, id: string, text: string, now: number, base?: number): DraftsFile =>
    writeIn(file, person, { id, text, base }, now).file;

describe("writeIn", () => {
    test("a first write starts the draft now and hands out the next revision", () => {
        const { file, change } = writeIn(EMPTY, ADA, { id: "conv-1", text: "fix the login" }, 1000);
        expect(change).toEqual({ answer: { draft: { conversationId: "conv-1", text: "fix the login", since: 1000, revision: 1 } }, changed: true });
        expect(file.revision).toBe(1);
    });

    test("a write from the revision it read keeps when the words were first held", () => {
        const first = written(EMPTY, ADA, "conv-1", "fix", 1000);
        const { change } = writeIn(first, ADA, { id: "conv-1", text: "fix the login", base: 1 }, 5000);
        expect(change.answer.draft).toEqual({ conversationId: "conv-1", text: "fix the login", since: 1000, revision: 2 });
    });

    test("words edited from an older revision are not written over newer ones: the newer draft comes back as a conflict", () => {
        const twice = written(written(EMPTY, ADA, "conv-1", "fix", 1000), ADA, "conv-1", "fix the login page", 2000, 1);
        const { file, change } = writeIn(twice, ADA, { id: "conv-1", text: "fix it", base: 1 }, 3000);
        expect(file).toBe(twice);
        expect(change).toEqual({
            answer: { draft: { conversationId: "conv-1", text: "fix the login page", since: 1000, revision: 2 }, conflict: true },
            changed: false,
        });
    });

    test("a draft sent since the writer read it is a conflict with no draft, so sent words never come back as unsent", () => {
        const sent = clearIn(written(EMPTY, ADA, "conv-1", "fix", 1000), ADA, "conv-1", 1).file;
        const { file, change } = writeIn(sent, ADA, { id: "conv-1", text: "fix", base: 1 }, 2000);
        expect(file).toBe(sent);
        expect(change).toEqual({ answer: { conflict: true }, changed: false });
    });

    test("empty words and no files clear the draft", () => {
        const held = written(EMPTY, ADA, "conv-1", "fix", 1000);
        const { file, change } = writeIn(held, ADA, { id: "conv-1", text: "  \n", attachments: [], base: 1 }, 2000);
        expect(file.people).toEqual({});
        expect(change).toEqual({ answer: {}, changed: true });
    });

    test("files alone are a draft", () => {
        const { change } = writeIn(EMPTY, ADA, { id: "conv-1", text: "", attachments: ["uploads/shot.png"] }, 1000);
        expect(change.answer.draft?.attachments).toEqual(["uploads/shot.png"]);
    });

    test("two people's drafts for one conversation are two drafts", () => {
        const both = written(written(EMPTY, ADA, "conv-1", "from ada", 1000), BOB, "conv-1", "from bob", 2000);
        expect(draftsOf(both, ADA).map((draft) => draft.text)).toEqual(["from ada"]);
        expect(draftsOf(both, BOB).map((draft) => draft.text)).toEqual(["from bob"]);
    });
});

describe("clearIn", () => {
    test("clears only the revision named, so words typed since elsewhere survive", () => {
        const twice = written(written(EMPTY, ADA, "conv-1", "fix", 1000), ADA, "conv-1", "fix more", 2000, 1);
        const { file, change } = clearIn(twice, ADA, "conv-1", 1);
        expect(file).toBe(twice);
        expect(change.answer).toEqual({ draft: { conversationId: "conv-1", text: "fix more", since: 1000, revision: 2 }, conflict: true });
    });

    test("clearing a draft already gone does nothing, so a send and its own clear go exactly once between them", () => {
        const held = written(EMPTY, ADA, "conv-1", "fix", 1000);
        const once = clearIn(held, ADA, "conv-1", 1);
        const again = clearIn(once.file, ADA, "conv-1", 1);
        expect([once.change.changed, again.change.changed]).toEqual([true, false]);
        expect(again.file).toBe(once.file);
    });

    test("never touches another person's draft", () => {
        const both = written(written(EMPTY, ADA, "conv-1", "from ada", 1000), BOB, "conv-1", "from bob", 2000);
        const { file } = clearIn(both, ADA, "conv-1", undefined);
        expect(draftsOf(file, BOB).map((draft) => draft.text)).toEqual(["from bob"]);
        expect(draftsOf(file, ADA)).toEqual([]);
    });
});

describe("draftsOf and heldSinceIn", () => {
    test("lists newest first", () => {
        const two = written(written(EMPTY, ADA, "conv-1", "older", 1000), ADA, "conv-2", "newer", 2000);
        expect(draftsOf(two, ADA).map((draft) => draft.conversationId)).toEqual(["conv-2", "conv-1"]);
    });

    test("a conversation is held since the earliest of anybody's drafts for it, and by nobody once all are gone", () => {
        const both = written(written(EMPTY, BOB, "conv-1", "from bob", 2000), ADA, "conv-1", "from ada", 1000);
        expect(heldSinceIn(both, "conv-1")).toBe(1000);
        const cleared = clearIn(clearIn(both, ADA, "conv-1", undefined).file, BOB, "conv-1", undefined).file;
        expect(heldSinceIn(cleared, "conv-1")).toBeUndefined();
    });
});
