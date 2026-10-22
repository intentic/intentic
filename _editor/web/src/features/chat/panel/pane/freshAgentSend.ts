import { computed, type Ref } from "vue";
import type { SendIntent } from "../../composer/composerIntent";
import type { InputHistory } from "../../drafts/inputHistory";
import { startAgent } from "../../../../models/fleet/agentActions";
import type { ChatAttachment } from "../../../../models/conversations/transcript/transcript";
import type { ConversationView } from "../../../../models/conversations/panel/useChat-view";

// Cmd/Ctrl+Enter: the draft opens a new agent instead of joining this conversation, as if typed into "New agent". The
// words and staged files leave this box for the new agent's first message, and the caret follows them there.

export interface FreshAgentHost {
    readonly view: ConversationView;
    readonly staging: { readonly snapshot: () => ChatAttachment[] };
    readonly history: Readonly<Ref<InputHistory | undefined>>;
    readonly reachable: Readonly<Ref<boolean>>;
    // What a plain Send means here; only a message of the person's own may leave for another agent.
    readonly intent: Readonly<Ref<SendIntent>>;
    // Why Send refuses (a file still uploading or failed); the same refusal holds for the new agent.
    readonly refusal: Readonly<Ref<string | undefined>>;
}

// Words that belong to this conversation's own state: placed as the agent's, an armed edit, notes on a pending plan.
const BOUND_HERE: ReadonlySet<SendIntent> = new Set([`place`, `edit`, `plan`]);

export const useFreshAgentSend = (host: FreshAgentHost) => {
    const { view } = host;
    const { draft, attachments } = view;
    // A chat with nothing sent yet already is a new agent, so the key just sends there; another box's chat would open
    // its new agent in this browser's box, so it sends there too.
    const offered = computed(() => {
        const chat = view.conversation.value;
        const started = chat.registered.value || chat.session.value !== undefined || view.messages.value.length > 0;
        return (
            started &&
            chat.box.value === undefined &&
            host.reachable.value &&
            view.connected.value &&
            draft.value.trim().length > 0 &&
            host.refusal.value === undefined &&
            !BOUND_HERE.has(host.intent.value)
        );
    });
    return {
        offered,
        // Whether the draft went to a new agent; false leaves the key to the ordinary send.
        start: (): boolean => {
            if (!offered.value) {
                return false;
            }
            const text = draft.value.trim();
            const files = host.staging.snapshot();
            startAgent(text, undefined, undefined, files.length > 0 ? { files } : undefined);
            host.history.value?.record(text);
            draft.value = ``;
            attachments.value = [];
            return true;
        },
    };
};
