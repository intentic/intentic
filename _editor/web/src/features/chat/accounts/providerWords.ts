import type { ProviderAccess } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// PROVIDER_SPECS says what each provider needs and what it runs in English, for the daemon and the agents as much as
// for the screen. These are the screen's words for the phrases that are not a vendor's own name, filed under the
// contract's phrase: a phrase with no entry ("Z.ai GLM Coding Plan", "Claude Code", one the contract gains later) is
// shown as the contract spells it. providerWords.test.ts holds the English of each entry to its phrase.

/** How a sentence uses the requirement: on its own (a chip), as what is needed, or as what gets connected. */
export type RequirementForm = `name` | `needed` | `object`;

type Forms = Readonly<Record<RequirementForm, () => string>>;

const REQUIREMENTS: ReadonlyMap<string, Forms> = new Map<string, Forms>([
    [
        `Claude subscription`,
        {
            name: () => t(`chat.providerWords.claude.requirement`),
            needed: () => t(`chat.providerWords.claude.requirementNeeded`),
            object: () => t(`chat.providerWords.claude.requirementObject`),
        },
    ],
    [
        `ChatGPT subscription`,
        {
            name: () => t(`chat.providerWords.codex.requirement`),
            needed: () => t(`chat.providerWords.codex.requirementNeeded`),
            object: () => t(`chat.providerWords.codex.requirementObject`),
        },
    ],
    [
        `SuperGrok subscription`,
        {
            name: () => t(`chat.providerWords.grok.requirement`),
            needed: () => t(`chat.providerWords.grok.requirementNeeded`),
            object: () => t(`chat.providerWords.grok.requirementObject`),
        },
    ],
    [
        `Kimi Code subscription`,
        {
            name: () => t(`chat.providerWords.kimi.requirement`),
            needed: () => t(`chat.providerWords.kimi.requirementNeeded`),
            object: () => t(`chat.providerWords.kimi.requirementObject`),
        },
    ],
    [
        `Google sign-in`,
        {
            name: () => t(`chat.providerWords.gemini.requirement`),
            needed: () => t(`chat.providerWords.gemini.requirementNeeded`),
            object: () => t(`chat.providerWords.gemini.requirementObject`),
        },
    ],
    [
        `Cursor Pro subscription`,
        {
            name: () => t(`chat.providerWords.cursor.requirement`),
            needed: () => t(`chat.providerWords.cursor.requirementNeeded`),
            object: () => t(`chat.providerWords.cursor.requirementObject`),
        },
    ],
    [
        `Muse Code subscription`,
        {
            name: () => t(`chat.providerWords.meta.requirement`),
            needed: () => t(`chat.providerWords.meta.requirementNeeded`),
            object: () => t(`chat.providerWords.meta.requirementObject`),
        },
    ],
]);

const RUNS: ReadonlyMap<string, () => string> = new Map([
    [`Gemini, Claude and GPT-OSS under Claude Code`, () => t(`chat.providerWords.gemini.runs`)],
    [`Muse Spark under Claude Code`, () => t(`chat.providerWords.meta.runs`)],
    [`GLM under Claude Code`, () => t(`chat.providerWords.zai.runs`)],
]);

/** What the provider needs, in the reader's language and in the form the sentence around it takes. */
export const requirementWords = (access: Pick<ProviderAccess, `requirement`>, form: RequirementForm): string =>
    REQUIREMENTS.get(access.requirement)?.[form]() ?? access.requirement;

/** What connecting it lets the reader run. */
export const runsWords = (access: Pick<ProviderAccess, `runs`>): string => RUNS.get(access.runs)?.() ?? access.runs;
