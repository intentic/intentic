import { capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract";

/* WHICH MODELS THE SYSTEM PROMPT ACTUALLY REACHES, grouped by what each does with it.
 *
 * The setting used to be silent about this, which is the worst shape a settings page can take: a turn on Codex,
 * Grok or Gemini ran without the prompt the owner had written and nothing on screen was wrong. The daemon now
 * declares what every runtime will take (AgentCapabilities.instructions) and composes to it, this reads the
 * SAME record so the sentence under the control cannot drift from what the turn does.
 *
 * DERIVED, NEVER TYPED. A hand-written "applies to Claude and Codex" is a sentence that is true on the day it is
 * written; a provider added next month lands in the right group here without anybody remembering this file.
 *
 * Each provider is asked about its OWN runtime, because that is the case the reader cannot see: picking the
 * Claude Code harness for a routed provider puts it on the loop that replaces, and the composer already says so
 * per conversation (limitationsOf). This answers the question the settings page is being asked, "who does this
 * apply to", for the default each provider runs on. */

export interface PromptReach {
    // Providers whose whole system prompt this setting replaces.
    readonly replaces: string[];
    // Providers that keep their own prompt and take this as an addition to it.
    readonly adds: string[];
}

export const promptReach = (): PromptReach => {
    const replaces: string[] = [];
    const adds: string[] = [];
    for (const provider of PROVIDERS) {
        const { instructions } = capabilitiesOf(provider.value, `native`);
        if (instructions === `replace`) {
            replaces.push(provider.label);
        }
        if (instructions === `append`) {
            adds.push(provider.label);
        }
    }
    return { replaces, adds };
};

// "A, B and C", the list as a person would read it aloud. A group is never empty in practice (every provider
// declares one of the two answers), but an empty one renders as nothing rather than as a dangling "and".
export const spokenList = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? ``) : `${items.slice(0, -1).join(`, `)} and ${items[items.length - 1]}`;
