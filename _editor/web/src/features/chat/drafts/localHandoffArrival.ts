import { t } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { router } from "../../../router";
import { useNotifications } from "../../../shell/notifications/notifications";
import { startAgent } from "../../agents/fleet/agentActions";
import { useAuth } from "../../auth/useAuth";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { drawsChat } from "../run/chatEcho";
import { type LocalHandoff, takeHandoff } from "./localHandoff";
import { queueAttachment } from "./pendingAttachments";

// Brings the file a kept handoff names (localHandoff.ts) into a new chat, once this window can show one: signed in, on
// a sandbox that answers, on a screen of the shell rather than a sign-in or setup one, and drawing the chat itself
// rather than leaving it to a floating window of its own. The file is read from the user's own computer with its
// one-file bearer, and handed to the new chat's composer, which uploads it as it would a dropped file. Nothing is sent:
// what to ask about it is the reader's to write.

// The shell's own screens: the route whose children are the workspace, the chat, the agents.
const inShell = (route: RouteLocationNormalizedLoaded): boolean => route.matched[0]?.path === `/`;

// The file as the app's file server hands it over: its bytes, under the handoff's name and the answer's content type.
const fetchFile = async (handoff: LocalHandoff): Promise<File> => {
    const response = await fetch(handoff.url, { headers: { Authorization: `Bearer ${handoff.token}` } });
    if (!response.ok) {
        throw new Error(`the file server answered ${response.status}`);
    }
    return new File([await response.arrayBuffer()], handoff.name, { type: response.headers.get(`content-type`) ?? `` });
};

const bring = async (handoff: LocalHandoff): Promise<void> => {
    const { say, warn } = useNotifications();
    let file: File;
    try {
        file = await fetchFile(handoff);
    } catch {
        // An expired bearer, an app that has quit, a file moved since: the reader can only ask again from where it is.
        warn(t(`chat.localHandoff.failed`, { name: handoff.name }));
        return;
    }
    const conversationId = startAgent();
    queueAttachment({ conversationId, file, taken: () => say(t(`chat.localHandoff.attached`, { name: handoff.name })) });
};

// The one watch, set on the first handoff; `ready` is read again for each later one.
let ready: (() => boolean) | undefined;

const bringWaiting = (): void => {
    if (ready?.() !== true) {
        return;
    }
    const handoff = takeHandoff();
    if (handoff !== undefined) {
        void bring(handoff);
    }
};

/** Brings a kept handoff's file in now if this window can show a chat, else as soon as it can. Idempotent. */
export const startLocalHandoff = (): void => {
    if (ready === undefined) {
        const { user } = useAuth();
        const { activeSandboxId, reachable } = useSandbox();
        const canShow = computed(
            () =>
                user.value !== null &&
                activeSandboxId.value !== undefined &&
                reachable.value &&
                drawsChat.value &&
                inShell(router.currentRoute.value),
        );
        ready = () => canShow.value;
        watch(canShow, bringWaiting);
    }
    bringWaiting();
};
