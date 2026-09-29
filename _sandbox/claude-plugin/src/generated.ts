import { fieldNotesPrompt } from "@intentic/agent-context/field-notes-prompt";
import { BACKGROUND_WAIT_GUIDANCE, BATCHING_GUIDANCE, CONTEXT_REUSE_GUIDANCE } from "@intentic/agent-context/guidance";
import { fileqSkill } from "@intentic/fileq/skill";

// The plugin files whose words belong to other packages: fileq's skill, the field-notes brief, the working guidance. The
// build writes them into generated/ (git ignores it) so each stays single-sourced where it is owned and maintained.

// The field notes the plugin reads (hook-io.ts fieldNotesFile), as the skill names them; Claude Code substitutes the
// project directory when the skill loads.
const NOTES_FILE = "${CLAUDE_PROJECT_DIR}/.claude/intentic/field-notes.toon";

// A first rewrite has no file to carry forward, so it gets the shape to start from; the reader (field-notes.ts) refuses
// anything whose index does not name its sections.
const FIRST_FILE = `If the file does not exist yet, start from this shape and replace every value:

\`\`\`
meta:
  title: Field notes for this project
  written: 2026-01-31
  basis: 42 sessions from 2026-01-01 to 2026-01-31
priority[2]{rank,id,title,cost}:
  1,verify,Which commands really verify,"a passing run that proved nothing"
  2,traps,Traps the code does not mention,"calls lost to the same failure"
verify:
  tests: pnpm test runs the unit suites only; integration needs pnpm test:int
traps:
  generated: src/schema.ts is generated; edit schema.graphql and run the generator
\`\`\``;

export const fieldNotesSkill = (): string => `---
name: field-notes
description: Rewrite this project's field notes, the brief every Claude Code session here opens with, from the sessions already run in this project. Run it every few weeks, or after a stretch of sessions lost time to the same trap.
disable-model-invocation: true
allowed-tools: Bash(intentic-notes-evidence *)
---

${fieldNotesPrompt({
    owner: "this project's",
    place: "this project",
    file: NOTES_FILE,
    reader: "the intentic plugin",
    evidence:
        "The evidence is the digest below: this project's own Claude Code sessions, read back and counted by the plugin " +
        "(failures by how many sessions hit them, the commands that ran and how often they failed, the files edited most, " +
        "how sessions opened). Open a transcript it names when a count needs its story.",
    period: "the latest",
    quietSpan: "the sessions since the last rewrite",
})}

${FIRST_FILE}

## Evidence

!\`intentic-notes-evidence --project "\${CLAUDE_PROJECT_DIR}"\`
`;

// No `${user_config.*}` in the command: Claude Code leaves one unexpanded for an option nobody set, and the Bash tool's
// permission parser refuses the whole line over it. The report reads the switches the last session opened with instead.
export const statsSkill = (): string => `---
name: stats
description: Show what the intentic plugin saved in this project — Bash output trimmed, and what the project map, field notes and iq teaching changed against the sessions held out without them. Add "all" for every project.
disable-model-invocation: true
allowed-tools: Bash(intentic-stats *)
argument-hint: "[all]"
---

!\`intentic-stats --data "\${CLAUDE_PLUGIN_DATA}" --project "\${CLAUDE_PROJECT_DIR}" $ARGUMENTS\`

Show the report above to the person as it is. Then say, in one or two sentences, what stands out: a cleaner worth switching off, a mechanism whose reading is not moving, or a comparison that needs a larger held-out share (\`holdout\`, \`output_holdout\` in /config) to resolve. Run nothing else.
`;

export const fileqSkillText = (): string => fileqSkill({ host: "standalone" });

// iq's nudge is written for the sandbox, where iq is baked into the image and a non-Claude runtime reads the skill from
// the workspace's `.agents/skills`. Everything else in it holds anywhere, so the plugin ships it with those two
// phrases said for a plain install; a rewording upstream fails the build here rather than shipping a sandbox path.
const SANDBOX_PHRASES: readonly (readonly [string, string])[] = [
    ["is a pre-installed CLI in this workspace", "is installed here"],
    ["run `iq --help` or read `.agents/skills/iq/SKILL.md` for the verb cheat-sheet", "run `iq --help` or load the iq skill for the verb cheat-sheet"],
];

export const portableIqNudge = (nudge: string): string =>
    SANDBOX_PHRASES.reduce((text, [sandbox, anywhere]) => {
        if (!text.includes(sandbox)) {
            throw new Error(`iq's nudge no longer says "${sandbox}"; update SANDBOX_PHRASES in generated.ts to its new wording`);
        }
        return text.replace(sandbox, anywhere);
    }, nudge);

// Opt-in: a person picks it with /output-style, and it adds to Claude Code's own instructions rather than replacing them.
export const outputStyle = (): string => `---
name: Intentic
description: Intentic's working habits — batch independent lookups into one response, reuse what is already in context, and run long commands in the background instead of sleeping.
keep-coding-instructions: true
---

# Working habits

${BATCHING_GUIDANCE}

${CONTEXT_REUSE_GUIDANCE}

${BACKGROUND_WAIT_GUIDANCE}
`;
