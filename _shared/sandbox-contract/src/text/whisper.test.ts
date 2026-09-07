import { expect, test } from "vitest";
import { cleanTranscription } from "./whisper.js";

test("flattens whisper output onto one line", () => {
    expect(cleanTranscription(" Hello there.\n General Kenobi.\n")).toBe("Hello there. General Kenobi.");
});

// The whole reason this filter exists: whisper narrates silence, and a narration dispatched as speech is a
// turn nobody asked for.
test("drops noise-only annotations, in both bracket styles", () => {
    expect(cleanTranscription(" [BLANK_AUDIO]\n")).toBeUndefined();
    expect(cleanTranscription("(wind blowing)")).toBeUndefined();
    expect(cleanTranscription("")).toBeUndefined();
});

// An annotation next to real speech drops the annotation and keeps the speech: the utterance did happen.
test("keeps speech that arrived alongside an annotation", () => {
    expect(cleanTranscription("[music] \nreal words")).toBe("real words");
});
