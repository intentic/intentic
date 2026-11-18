import { BACKGROUND_WAIT_GUIDANCE, BATCHING_GUIDANCE, CONTEXT_REUSE_GUIDANCE } from "@intentic/agent-context/guidance";
import { fileqSkill } from "@intentic/fileq/skill";

// The plugin files whose words belong to other packages: fileq's skill and the working guidance. The
// build writes them into generated/ (git ignores it) so each stays single-sourced where it is owned and maintained.

// No `${user_config.*}` in the command: Claude Code leaves one unexpanded for an option nobody set, and the Bash tool's
// permission parser refuses the whole line over it. The report reads the switches the last session opened with instead.
export const statsSkill = (): string => `---
name: stats
description: Show what the intentic plugin saved in this project — Bash output trimmed, and what the project map changed against the sessions held out without it. Add "all" for every project.
disable-model-invocation: true
allowed-tools: Bash(intentic-stats *)
argument-hint: "[all]"
---

!\`intentic-stats --data "\${CLAUDE_PLUGIN_DATA}" --project "\${CLAUDE_PROJECT_DIR}" $ARGUMENTS\`

Show the report above to the person as it is. Then say, in one or two sentences, what stands out: a cleaner worth switching off, a mechanism whose reading is not moving, or a comparison that needs a larger held-out share (\`holdout\`, \`output_holdout\` in /config) to resolve. Run nothing else.
`;

export const fileqSkillText = (): string => fileqSkill({ host: "standalone" });

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
