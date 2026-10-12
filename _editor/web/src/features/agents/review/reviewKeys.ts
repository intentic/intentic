import type { Disposable } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { customRef, onBeforeUnmount, onMounted, type Ref } from "vue";
import { AGENTS } from "../../../workbench/commands/categories";
import { publishContextKey } from "../../../workbench/commands/contextKeys";
import { registerCommand } from "../../../workbench/commands/useCommands";

// The review pass's one-key peers (arrows or j/k to move, v to mark a file viewed and advance, Shift+V for its whole
// group), claimed in the command registry while a review is on screen. Being commands is what puts them in the
// palette and the Keybindings page, lets a reader remap them, and lets the hovers show the chord actually bound.

export const REVIEW_NEXT = `agents.review.nextFile`;
export const REVIEW_PREVIOUS = `agents.review.previousFile`;
export const REVIEW_MARK = `agents.review.markViewed`;
export const REVIEW_MARK_GROUP = `agents.review.markGroupViewed`;

export interface ReviewKeysHost {
    // The panel's own box: a review held behind a phone's chat page (SwipePages) is inert, and a `v` there would mark
    // files nobody is looking at.
    readonly panel: Readonly<Ref<HTMLElement | null>>;
    readonly move: (delta: number) => void;
    readonly viewAndAdvance: () => void;
    readonly viewGroupAndAdvance: () => void;
}

export const useReviewKeys = (host: ReviewKeysHost): void => {
    // Read at each keystroke rather than cached: whether the panel sits inside an `[inert]` page is a fact of the DOM,
    // which nothing reactive would tell a computed about.
    const onScreen = customRef<boolean>(() => ({
        get: () => host.panel.value !== null && host.panel.value.closest(`[inert]`) === null,
        set: () => undefined,
    }));
    // Bare letters and arrows belong to whatever field has the caret: the chat composer, Monaco, a filter.
    const when = `agentReviewOnScreen && !editableTarget`;
    let claims: readonly Disposable[] = [];
    onMounted(() => {
        const next = (): void => host.move(1);
        const previous = (): void => host.move(-1);
        claims = [
            publishContextKey(`agentReviewOnScreen`, onScreen),
            registerCommand({ owner: `builtin`, command: REVIEW_NEXT, title: t(`agents.agentReviewPanel.nextFile`), category: AGENTS, icon: `chevron-down`, keybinding: `j`, when, handler: next }),
            registerCommand({
                owner: `builtin`,
                command: REVIEW_PREVIOUS,
                title: t(`agents.agentReviewPanel.previousFile`),
                category: AGENTS,
                icon: `chevron-up`,
                keybinding: `k`,
                when,
                handler: previous,
            }),
            // The arrows are the same moves under the keys everyone tries first; a command carries one chord, so each
            // is a command of its own.
            registerCommand({
                owner: `builtin`,
                command: `${REVIEW_NEXT}.arrow`,
                title: t(`agents.agentReviewPanel.nextFile`),
                category: AGENTS,
                icon: `chevron-down`,
                keybinding: `ArrowDown`,
                when,
                handler: next,
            }),
            registerCommand({
                owner: `builtin`,
                command: `${REVIEW_PREVIOUS}.arrow`,
                title: t(`agents.agentReviewPanel.previousFile`),
                category: AGENTS,
                icon: `chevron-up`,
                keybinding: `ArrowUp`,
                when,
                handler: previous,
            }),
            registerCommand({
                owner: `builtin`,
                command: REVIEW_MARK,
                title: t(`agents.agentReviewPanel.markReviewed`),
                category: AGENTS,
                icon: `check`,
                keybinding: `v`,
                when,
                handler: host.viewAndAdvance,
            }),
            registerCommand({
                owner: `builtin`,
                command: REVIEW_MARK_GROUP,
                title: t(`agents.agentReviewPanel.markGroupReviewed`),
                category: AGENTS,
                icon: `check-check`,
                keybinding: `Shift+V`,
                when,
                handler: host.viewGroupAndAdvance,
            }),
        ];
    });
    onBeforeUnmount(() => {
        for (const claim of claims) {
            claim.dispose();
        }
        claims = [];
    });
};
