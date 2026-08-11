import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const IQ_SEARCH_INSTRUCTION_HEADER = "## iq workspace search";

/* Claude Code reads this material through the plugin loader. Native Codex and OpenCode have no plugin seam,
 * so their opening request carries the same nudge and skill body as a disclosed turn preamble. Reading the
 * shipped files instead of maintaining a shortened copy is what keeps every harness in the same treatment arm
 * when the skill changes. */
export interface IqSearchTeaching {
    readonly note: string;
    // Content address rather than package version: this experiment measures the words the model received, and
    // a copy edit to the skill is a new treatment even when the surrounding package version did not move.
    readonly cohort: string;
}

const teachingByPlugin = new Map<string, Promise<IqSearchTeaching>>();

const loadIqSearchInstruction = async (pluginDir: string): Promise<IqSearchTeaching> => {
    const [skillSource, nudgeSource] = await Promise.all([
        readFile(join(pluginDir, "skills/iq/SKILL.md"), "utf8"),
        readFile(join(pluginDir, "hooks/nudge.txt"), "utf8"),
    ]);
    const skill = skillSource.replace(/^---[\s\S]*?---\s*/, "").trim();
    const body = `${nudgeSource.trim()}\n\n${skill}`;
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
