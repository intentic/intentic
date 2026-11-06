import { BACKGROUND_WAIT_GUIDANCE, BATCHING_GUIDANCE, CONTEXT_REUSE_GUIDANCE } from "@intentic/agent-context/guidance";
import { fileqSkill } from "@intentic/fileq/skill";

// The plugin files whose words belong to other packages: fileq's skill and the working guidance. The
// build writes them into generated/ (git ignores it) so each stays single-sourced where it is owned and maintained.

// No `${user_config.*}` in the command: Claude Code leaves one unexpanded for an option nobody set, and the Bash tool's
// permission parser refuses the whole line over it. The report reads the switches the last session opened with instead.
export const statsSkill = (): string => `---
name: stats
description: Show what the intentic plugin saved in this project — Bash output trimmed, and what the project map and iq teaching changed against the sessions held out without them. Add "all" for every project.
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
