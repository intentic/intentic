import type { SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { shallowReactive } from "vue";

// What has been typed into a skill's page and not saved, by the page's key (the skill's id, or NEW_SKILL). A Workspace
// tab unmounts when another tab is picked, and a page that kept its text in its own refs threw it away on that click.
// Held only while it differs from what is saved, so a clean page always reads the daemon's latest.

/** The key a skill being written, not yet saved, keeps its page and its draft under. */
export const NEW_SKILL = `+new`;

// allow(module-state): unsaved text has to outlive the page component that shows it, for as long as the window lives
const drafts = shallowReactive(new Map<string, SkillDraft>());

export const heldDraft = (key: string): SkillDraft | undefined => drafts.get(key);

export const holdDraft = (key: string, draft: SkillDraft): void => {
    drafts.set(key, draft);
};

export const dropDraft = (key: string): void => {
    drafts.delete(key);
};
