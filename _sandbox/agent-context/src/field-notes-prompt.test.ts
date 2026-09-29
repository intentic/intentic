import { fieldNotesPrompt, type FieldNotesPlace } from "./field-notes-prompt.js";

// The brief is one text with a place poured into it; what must hold for any place is that every slot is filled and the
// shape the reader slices by is spelled out.

const PROJECT: FieldNotesPlace = {
    owner: "this project's",
    place: "this project",
    file: ".claude/intentic/field-notes.toon",
    reader: "the plugin",
    evidence: "The evidence is the digest printed above.",
    period: "the latest",
    quietSpan: "the sessions since the last rewrite",
};

test("names the file, the place and the reader it was given", () => {
    const text = fieldNotesPrompt(PROJECT);
    expect(text.startsWith("Rewrite this project's field notes: `.claude/intentic/field-notes.toon`, the brief every turn opens with.")).toBe(true);
    expect(text).toContain("VERIFY EVERY FACT AGAINST THIS PROJECT BEFORE YOU WRITE IT DOWN.");
    expect(text).toContain("because the plugin reads it by rank");
    expect(text).toContain("drop what the project has outgrown, re-rank on the latest evidence.");
    expect(text).toContain("If the sessions since the last rewrite genuinely showed nothing worth changing");
    expect(text).toContain(
        "The evidence is the digest printed above. Work from counts, not impressions: how MANY sessions hit a thing is what decides its rank",
    );
});

test("spells out the shape field-notes.ts slices by rank", () => {
    const text = fieldNotesPrompt(PROJECT);
    expect(text).toContain("a `meta` block, a `priority` table whose columns begin `rank,id` and whose every id is also a top-level key");
    expect(text).toContain("Ranks are integers and ids are kebab-case words.");
});
