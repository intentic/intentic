import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { openById } from "../../agents/fleet/useAgents-actions";
import { rosterHeard } from "../../agents/fleet/useAgents-registry";

/**
 * The full-window chat's half of a link naming a conversation (router/conversationLink.ts): `/chat?focus=<id>` opens
 * that conversation here, as the board's `?focus=` opens its card. Waits for the roster, so a cold start opens the
 * agent's own tab (its lane, its settings) rather than a bare session; one-shot, so a reload or Back does not open it
 * again after the reader moved on.
 */
export const useChatFocusLink = (): void => {
    const route = useRoute();
    const router = useRouter();
    const requested = ref<string | undefined>(undefined);
    watch(
        () => route.query[`focus`],
        (value) => {
            if (typeof value === `string` && value !== ``) {
                requested.value = value;
            }
        },
        { immediate: true },
    );
    watch(
        [requested, rosterHeard],
        ([id, heard]) => {
            if (id === undefined || !heard) {
                return;
            }
            requested.value = undefined;
            void router.replace({ query: { ...route.query, focus: undefined } });
            openById(id);
        },
        { immediate: true },
    );
};
