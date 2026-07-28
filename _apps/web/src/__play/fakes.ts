import { computed, ref } from "vue";

/* Throwaway stand-ins for the app singletons ChatMessageView reaches for, so the playground can render the
 * REAL component without the router, sandbox client, or platform API. Aliased in by vite.play.config.ts. */

export const useChat = (): Record<string, unknown> => ({
    decidePlan: () => undefined,
    planApprovals: computed(() => ({})),
    answerQuestion: () => undefined,
    cancelQuestion: () => undefined,
    decidePermission: () => undefined,
    openPlanPreview: () => undefined,
    editAndResend: () => undefined,
    streaming: ref(false),
    awaitingDecision: ref(false),
});

export const restoreSnapshot = (): Promise<void> => Promise.resolve();
export const openFileRefFromEvent = (): void => undefined;
export const attachmentPreview = (): string | undefined => undefined;
