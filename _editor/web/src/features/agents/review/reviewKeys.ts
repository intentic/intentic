import type { Disposable } from "@intentic/extension-api";
import { customRef, onBeforeUnmount, onMounted, type Ref } from "vue";
import { publishContextKey } from "../../../workbench/commands/contextKeys";
import { registerBuiltin } from "../../../workbench/commands/builtinCommands";

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
    // Bare letters and arrows belong to whatever field has the caret (the chat composer, Monaco, a filter): each chord is
    // gated on `agentReviewOnScreen && !editableTarget` in builtinCommands.ts.
    let claims: readonly Disposable[] = [];
    onMounted(() => {
        const next = (): void => host.move(1);
        const previous = (): void => host.move(-1);
        claims = [
            publishContextKey(`agentReviewOnScreen`, onScreen),
            registerBuiltin(REVIEW_NEXT, next),
            registerBuiltin(REVIEW_PREVIOUS, previous),
            // The arrows are the same moves under the keys everyone tries first; a command carries one chord, so each
            // is a command of its own.
            registerBuiltin(`agents.review.nextFile.arrow`, next),
            registerBuiltin(`agents.review.previousFile.arrow`, previous),
            registerBuiltin(REVIEW_MARK, host.viewAndAdvance),
            registerBuiltin(REVIEW_MARK_GROUP, host.viewGroupAndAdvance),
        ];
    });
    onBeforeUnmount(() => {
        for (const claim of claims) {
            claim.dispose();
        }
        claims = [];
    });
};
