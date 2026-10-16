import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cachedAsync } from "@intentic/base/held";
import { SEARCH_GUIDANCE } from "./guidance.js";
import { IQ_SEARCH_INSTRUCTION_HEADER } from "../../sessions/vocabulary/prompt-envelope.js";

// The chat-row title of the note whose header sessions/vocabulary/prompt-envelope.ts holds.
export const IQ_SEARCH_INSTRUCTION_TITLE = "Using iq for workspace search";

/* Claude Code reads the full skill through the plugin loader. */
export interface IqSearchTeaching {
    readonly note: string;
    // Content address rather than package version: this experiment measures the words the model received, and
    // a copy edit to the skill, or to the system prompt's search line the iq arm is given, is a new treatment even
    // when the surrounding package version did not move.
    readonly cohort: string;
}

// Held for good once read; a failed read is not held, so a plugin unreadable at one turn is read again at the next.
const teachingByPlugin = cachedAsync<string, IqSearchTeaching>({ ttlMs: Infinity });

const loadIqSearchInstruction = async (pluginDir: string): Promise<IqSearchTeaching> => {
    const nudgeSource = await readFile(join(pluginDir, "hooks/nudge.txt"), "utf8");
    const body = nudgeSource.trim();
    return {
        note: `${IQ_SEARCH_INSTRUCTION_HEADER}\n\n${body}`,
        cohort: createHash("sha256")
            .update(`${body}\0${SEARCH_GUIDANCE.iq}`)
            .digest("hex")
            .slice(0, 12),
    };
};

// The plugin is image-baked and immutable for a daemon's lifetime. Cache both reads so a measured conversation
// can stamp its cohort on every turn without turning that stamp into two filesystem reads per request.
export const iqSearchInstruction = (pluginDir: string): Promise<IqSearchTeaching> =>
    teachingByPlugin.get(pluginDir, () => loadIqSearchInstruction(pluginDir));
