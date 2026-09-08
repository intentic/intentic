import { capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract";

// Groups providers by what they do with the system prompt (replace vs. append), read from the daemon's own
// AgentCapabilities.instructions so the sentence can't drift from what a turn does. Derived rather than
// hand-written, so a new provider lands in the right group automatically; asks each provider's own native runtime.

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

// Joins as "A, B and C"; an empty list renders as nothing rather than a dangling "and".
export const spokenList = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? ``) : `${items.slice(0, -1).join(`, `)} and ${items.at(-1)}`;
