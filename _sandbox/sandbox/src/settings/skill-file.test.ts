import { expect, test } from "vitest";
import { parseSkillFile, skillDocument } from "./skill-file.js";

test("a composed skill round-trips through the parser", () => {
    const doc = skillDocument("release-notes", "Use when drafting release notes.", "# Notes\n\nRun `git log`.");
    expect(parseSkillFile(doc)).toEqual({
        name: "release-notes",
        description: "Use when drafting release notes.",
        body: "# Notes\n\nRun `git log`.\n",
    });
});

// A colon makes a description read as a YAML mapping too; written bare, it makes the frontmatter unparseable, silently,
// with no sign on screen that a skill just stopped loading.
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

// An indented continuation is how a hand-written frontmatter's long description arrives.
test("an indented continuation line appends to the value above it", () => {
    const parsed = parseSkillFile(`---\nname: kb\ndescription: Use this\n  when the user asks about notes\n---\n\nBody here.\n`);
    expect(parsed).toEqual({ name: "kb", description: "Use this when the user asks about notes", body: "Body here.\n" });
});

test("a quoted value is unquoted, and unknown keys are ignored", () => {
    const parsed = parseSkillFile(`---\nname: "kb"\nallowed-tools: Bash\ndescription: 'Notes'\n---\nBody`);
    expect(parsed).toEqual({ name: "kb", description: "Notes", body: "Body" });
});

// An unreadable frontmatter degrades to no description and the whole file as body, never a missing row. Three shapes
// reach here:
// no frontmatter
// an unclosed fence
// an empty declaration
test("a file with no readable frontmatter parses as body-only", () => {
    expect(parseSkillFile(`# Just markdown\n`)).toEqual({ body: `# Just markdown\n` });
    expect(parseSkillFile(`---\nname: unterminated\n`)).toEqual({ body: `---\nname: unterminated\n` });
    expect(parseSkillFile(`---\n---\nBody`)).toEqual({ body: `Body` });
});

// Guards against a shared `last` state leaking a continuation into whatever the previous call parsed.
test("a continuation with nothing above it is dropped", () => {
    expect(parseSkillFile(`---\n  orphan\nname: kb\n---\nBody`)).toEqual({ name: "kb", body: "Body" });
});
