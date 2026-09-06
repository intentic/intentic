import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const IQ_SEARCH_INSTRUCTION_HEADER = "## iq workspace search";
// The chat-row title, beside the header it belongs to (turn-preamble.ts explains the pairing).
export const IQ_SEARCH_INSTRUCTION_TITLE = "Using iq for workspace search";

/* Claude Code reads the full skill through the plugin loader. Native Codex and OpenCode have no plugin seam,
 * so their opening request carries the nudge only as a disclosed turn preamble — not the full SKILL.md body,
 * which would duplicate what Claude gets for free and cost ~1.8k tokens per conversation start. */
export interface IqSearchTeaching {
    readonly note: string;
    // Content address rather than package version: this experiment measures the words the model received, and
    // a copy edit to the skill is a new treatment even when the surrounding package version did not move.
    readonly cohort: string;
}

const teachingByPlugin = new Map<string, Promise<IqSearchTeaching>>();

const loadIqSearchInstruction = async (pluginDir: string): Promise<IqSearchTeaching> => {
    const nudgeSource = await readFile(join(pluginDir, "hooks/nudge.txt"), "utf8");
    const body = nudgeSource.trim();
    return {
        note: `${IQ_SEARCH_INSTRUCTION_HEADER}\n\n${body}`,
        cohort: createHash("sha256").update(body).digest("hex").slice(0, 12),
    };
};

// The plugin is image-baked and immutable for a daemon's lifetime. Cache both reads so a measured conversation
// can stamp its cohort on every turn without turning that stamp into two filesystem reads per request.
export const iqSearchInstruction = (pluginDir: string): Promise<IqSearchTeaching> => {
    const existing = teachingByPlugin.get(pluginDir);
    if (existing !== undefined) {
        return existing;
    }
    const loaded = loadIqSearchInstruction(pluginDir);
    teachingByPlugin.set(pluginDir, loaded);
    return loaded;
};
