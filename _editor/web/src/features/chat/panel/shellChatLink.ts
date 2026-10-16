import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";

/** Super+Space opens a blank draft. No message is sent and no agent starts until the person presses Send. */
export const useShellChatLink = (open: () => void): void => {
    const route = useRoute();
    const router = useRouter();
    watch(
        () => route.query[`shellChat`],
        (request) => {
            if (Array.isArray(request) || !request) {
                return;
            }
            void router.replace({ query: { ...route.query, shellChat: undefined } });
            open();
        },
        { immediate: true, flush: `post` },
    );
};
