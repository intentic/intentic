import { expect, test } from "vitest";
import { parseSkillFile, skillDocument } from "./skill-file.js";

// The two directions have to agree, because the daemon writes one and reads the other back: a skill saved on the
// Skills surface is re-listed by parsing the very file the save composed.
test("a composed skill round-trips through the parser", () => {
    const doc = skillDocument("release-notes", "Use when drafting release notes.", "# Notes\n\nRun `git log`.");
    expect(parseSkillFile(doc)).toEqual({
        name: "release-notes",
        description: "Use when drafting release notes.",
        body: "# Notes\n\nRun `git log`.\n",
    });
});

/* The value that would silently change what the frontmatter MEANS. A description reading "Use when: the user asks"
 * is an ordinary sentence and a YAML mapping at the same time, and written bare it makes the whole block
 * unparseable — which reaches the user as a skill the agent never picks, with nothing on screen looking wrong. */
test("a description containing a colon survives composing and parsing", () => {
    const description = `Use when: the user asks for a "changelog" #now`;
    const parsed = parseSkillFile(skillDocument("notes", description, "body"));
    expect(parsed.description).toBe(description);
});

test("a multi-line description is written as one line rather than a folded block", () => {
    const doc = skillDocument("notes", "First line.\n\nSecond line.", "body");
    expect(doc).toContain("description: First line. Second line.");
    expect(parseSkillFile(doc).description).toBe("First line. Second line.");
});

// Frontmatter written by hand or by another tool: an indented continuation is how a long description arrives, and
// dropping it would truncate the one line the model routes on.
test("an indented continuation line appends to the value above it", () => {
    const parsed = parseSkillFile(`---\nname: kb\ndescription: Use this\n  when the user asks about notes\n---\n\nBody here.\n`);
    expect(parsed).toEqual({ name: "kb", description: "Use this when the user asks about notes", body: "Body here.\n" });
});

test("a quoted value is unquoted, and unknown keys are ignored", () => {
    const parsed = parseSkillFile(`---\nname: "kb"\nallowed-tools: Bash\ndescription: 'Notes'\n---\nBody`);
    expect(parsed).toEqual({ name: "kb", description: "Notes", body: "Body" });
});

/* A file this cannot read still has to be listable — the Skills surface promises to show everything the agent is
 * carrying, so an unreadable frontmatter degrades to "no description" and the whole file as body, never to a
 * missing row. Three shapes reach here: no frontmatter, an unclosed fence, and an empty declaration. */
test("a file with no readable frontmatter parses as body-only", () => {
    expect(parseSkillFile(`# Just markdown\n`)).toEqual({ body: `# Just markdown\n` });
    expect(parseSkillFile(`---\nname: unterminated\n`)).toEqual({ body: `---\nname: unterminated\n` });
    expect(parseSkillFile(`---\n---\nBody`)).toEqual({ body: `Body` });
});

// An indented line before any key belongs to no field — it must not be attached to whatever was parsed last from
// some earlier call, which is the bug a shared `last` across invocations would produce.
test("a continuation with nothing above it is dropped", () => {
    expect(parseSkillFile(`---\n  orphan\nname: kb\n---\nBody`)).toEqual({ name: "kb", body: "Body" });
});
