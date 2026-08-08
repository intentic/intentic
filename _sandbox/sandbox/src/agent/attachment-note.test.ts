import { expect, test } from "vitest";
import { stripAttachmentNote, withAttachmentNote } from "./attachment-note.js";

const paths = ["/work/.intentic/artifacts/attachments/uuid-1/image.png", "/work/.intentic/artifacts/attachments/uuid-2/notes.pdf"];

test("strip is the builder's inverse", () => {
    expect(stripAttachmentNote(withAttachmentNote("fix the bug", paths))).toEqual({ text: "fix the bug", attachments: paths });
});

test("an attachment-only message strips to empty text with its paths intact", () => {
    expect(stripAttachmentNote(withAttachmentNote("", paths))).toEqual({ text: "", attachments: paths });
});

test("ordinary messages ride untouched", () => {
    expect(stripAttachmentNote("fix the bug")).toEqual({ text: "fix the bug", attachments: [] });
});

test("a user quoting the note wording mid-message keeps their text — strip anchors on the END", () => {
    const quoted = `${withAttachmentNote("look at this", paths)}\n\nDoes that text mean anything?`;
    expect(stripAttachmentNote(quoted)).toEqual({ text: quoted, attachments: [] });
});

test("a prompt whose own tail looks like a list is left alone — only the injected header anchors", () => {
    const listy = "todo:\n- one\n- two";
    expect(stripAttachmentNote(listy)).toEqual({ text: listy, attachments: [] });
});

test("a prompt containing dashes and blank lines survives the round trip", () => {
    const prompt = "intro\n\n- not an attachment\n\noutro";
    expect(stripAttachmentNote(withAttachmentNote(prompt, paths))).toEqual({ text: prompt, attachments: paths });
});
