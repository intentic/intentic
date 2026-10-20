import { onUnmounted, ref, watch, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AGENT_VIEW, CHANGES_VIEW, mobileChatPath } from "../../../lib/routes/phoneScreens";
import { subscribe as watchOtherBoxes } from "../../../models/sandbox/live/fleetAcross";
import { useChat } from "../../../models/conversations/run/useChat";

/* WHAT AN AGENT'S PAGE (AgentDetail.vue) DOES ON A PHONE AND INSIDE THE ANDROID APP, and the cross-sandbox store a remote
   review keeps alive: each a piece of that page with no other part of it to read. */

// The phone's chat switcher hangs off this screen's title: this is the only chat surface a phone has, so the open
// chats and the stored sessions have to be reachable from it. A pick is a navigation, since here a chat is a route.
export const usePhoneChatSwitcher = () => {
    const router = useRouter();
    const { setActive, openConversation, active } = useChat();
    const switcherOpen = ref(false);
    const switchTo = (id: string): void => {
        setActive(id);
        void router.push(mobileChatPath(id));
    };
    // openConversation mints the tab and focuses it; the route follows whatever it made active.
    const openPast = (sessionId: string): void => {
        openConversation(sessionId);
        void router.push(mobileChatPath(active.value.conversationId));
    };
    return { switcherOpen, switchTo, openPast };
};

// Mode switch only exists on mobile; desktop always renders the review. `?view=changes` opens a phone on the Changes
// page instead of the chat: a link's way to name the review, and the Android app's to show it alone.
export const useAgentView = (mobile: Readonly<Ref<boolean>>, inApp: boolean, agentId: Readonly<Ref<string>>): Ref<`chat` | `changes`> => {
    const route = useRoute();
    const router = useRouter();
    const askedView = (): `chat` | `changes` => (route.query[AGENT_VIEW] === CHANGES_VIEW ? `changes` : `chat`);
    const view = ref<`chat` | `changes`>(mobile.value ? askedView() : `changes`);
    watch(
        () => route.query[AGENT_VIEW],
        () => {
            if (mobile.value) {
                view.value = askedView();
            }
        },
    );
    // INSIDE THE ANDROID APP this screen is only ever an agent's Changes (app/environments/nativeApp.ts): its conversation
    // is the app's own screen, so turning to the chat page, by a finger or the switch or the review asking for it, goes
    // there (the router hands `/agents/<id>` to the app) and this page stays on the changes it was opened for.
    watch(view, (shown) => {
        if (inApp && shown === `chat`) {
            view.value = `changes`;
            void router.push(mobileChatPath(agentId.value));
        }
    });
    return view;
};

// Keeps the cross-sandbox store alive for as long as a remote review is open, since this page can be reached
// without the board (bookmark, reload, new tab); disposed with the page, so a local review costs nothing.
export const keepOtherBoxesWhile = (remote: Readonly<Ref<boolean>>): void => {
    let releaseBoxes: (() => void) | undefined;
    watch(
        remote,
        (isRemote) => {
            if (isRemote) {
                releaseBoxes ??= watchOtherBoxes();
                return;
            }
            releaseBoxes?.();
            releaseBoxes = undefined;
        },
        { immediate: true },
    );
    onUnmounted(() => {
        releaseBoxes?.();
        releaseBoxes = undefined;
    });
};
