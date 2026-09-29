import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BACKGROUND_WAIT_GUIDANCE, BATCHING_GUIDANCE, CONTEXT_REUSE_GUIDANCE } from "@intentic/agent-context/guidance";
import { fieldNotesSkill, fileqSkillText, outputStyle, portableIqNudge, statsSkill } from "./generated.js";

// The generated files carry other packages' words; these pin that the plugin's framing around them is what Claude Code
// needs (frontmatter, pre-approved commands, substitutions) and that nothing sandbox-only leaks through.

const frontmatter = (text: string): string => text.slice(4, text.indexOf("\n---\n", 4));

test("the iq nudge ships with its sandbox phrases said for a plain install", () => {
    const shipped = readFileSync(createRequire(import.meta.url).resolve("@intentic/iq/nudge"), "utf8");
    const portable = portableIqNudge(shipped);
    expect(portable).toContain("`iq` is installed here —");
    expect(portable).toContain("run `iq --help` or load the iq skill for the verb cheat-sheet");
    expect(portable).not.toContain(".agents/skills");
    expect(portable).not.toContain("pre-installed");
});

test("a reworded nudge fails the build instead of shipping a sandbox path", () => {
    expect(() => portableIqNudge("`iq` is a search CLI.")).toThrow("update SANDBOX_PHRASES");
});

test("the stats skill runs only its own pre-approved report, with nothing the permission parser could refuse", () => {
    const skill = statsSkill();
    expect(frontmatter(skill)).toContain("disable-model-invocation: true");
    expect(frontmatter(skill)).toContain("allowed-tools: Bash(intentic-stats *)");
    const command = skill.split("\n").find((line) => line.startsWith("!`"));
    expect(command).toBe('!`intentic-stats --data "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`');
    // An option nobody set stays `${user_config.KEY}` in the text, and Claude Code refuses to run the line at all.
    expect(skill).not.toContain("user_config");
});

test("the field-notes skill is the shared brief, for this project's file, over the evidence digest", () => {
    const skill = fieldNotesSkill();
    expect(frontmatter(skill)).toContain("allowed-tools: Bash(intentic-notes-evidence *)");
    expect(skill).toContain("Rewrite this project's field notes: `${CLAUDE_PROJECT_DIR}/.claude/intentic/field-notes.toon`");
    expect(skill).toContain("VERIFY EVERY FACT AGAINST THIS PROJECT");
    expect(skill.trimEnd().endsWith('!`intentic-notes-evidence --project "${CLAUDE_PROJECT_DIR}"`')).toBe(true);
});

test("fileq's skill is the standalone one: no textconv the install never wired", () => {
    const skill = fileqSkillText();
    expect(skill).toContain("name: fileq");
    expect(skill).not.toContain("textconv");
    expect(skill).toContain("a scan is OCR'd when `tesseract` is on PATH");
});

test("the output style adds the shared habits to Claude Code's own instructions", () => {
    const style = outputStyle();
    expect(frontmatter(style)).toContain("keep-coding-instructions: true");
    expect(style).toContain(BATCHING_GUIDANCE);
    expect(style).toContain(CONTEXT_REUSE_GUIDANCE);
    expect(style).toContain(BACKGROUND_WAIT_GUIDANCE);
});
