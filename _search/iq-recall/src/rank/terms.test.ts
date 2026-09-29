import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import { contentTermsOf, ftsQueryOf } from "./terms.js";

const MAP_NOTE = `## Map of this project\n\nThe workspace, four areas: sandbox, editor, extensions.`;

test("a daemon preamble is cut off before the prompt's content terms are taken", () => {
    expect(contentTermsOf(`${MAP_NOTE}${TURN_PREAMBLE_SEPARATOR}Rotate the JWT refresh token`)).toEqual(["rotate", "jwt", "refresh", "token"]);
});

test("a preamble with nothing but filler after it builds no query", () => {
    expect(ftsQueryOf(`${MAP_NOTE}${TURN_PREAMBLE_SEPARATOR}ok go ahead`)).toBe(undefined);
});

test("a prompt whose opening is no known note is left whole, separator and all", () => {
    expect(contentTermsOf(`# Notes on rotation${TURN_PREAMBLE_SEPARATOR}JWT refresh`)).toEqual(["notes", "rotation", "jwt", "refresh"]);
});

test("a note-like opening with no separator is left whole rather than cut at a guess", () => {
    expect(contentTermsOf("## Rotation plan\n\nJWT refresh")).toEqual(["rotation", "plan", "jwt", "refresh"]);
});
