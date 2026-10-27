import { computed } from "vue";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { effectiveAutoLand, turnInFlight } from "../../../models/agent-status/agentStatus-standing";
import { useAgents } from "../../../models/fleet/useAgents";
import { landsByDefault } from "../../../models/sandbox/environment/rules";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { useRole } from "../../../client/sandbox/useRole";
import type { Conversation } from "../../../models/conversations/session/conversation";

// The composer setting about how a conversation's work arrives rather than what it says: whether its finished work lands
// by itself, a standing answer of the conversation's (the board menu's "Land automatically"). Which agents a message can
// wait for is waitTargets.ts's.

/**
 * How a home conversation's finished work arrives, which is no answer of anybody's (the daemon's turn-landing.ts
 * homeOverride): when a turn ends, what it merged lands and is committed (`lands`), or, for a person who may not land
 * here, waits on its branch for a maintainer (`asks`). Undefined for every other chat, and for a home drawn from another
 * box, whose reader's standing there this tab does not know.
 */
export type HomeLanding = `lands` | `asks`;
export const homeLandingOf = (
    chat: { readonly conversationId: string; readonly box: string | undefined },
    canLandHome: boolean,
): HomeLanding | undefined => {
    if (!isHomeConversationId(chat.conversationId) || chat.box !== undefined) {
        return undefined;
    }
    return canLandHome ? `lands` : `asks`;
};

/**
 * This conversation's answer to whether its finished work lands by itself: its own where it gave one, else the
 * sandbox's. Offered where landing is this conversation's own business and the reader's to decide: a private copy on
 * this sandbox, for a maintainer, whose land it is. Before the daemon has a record of the conversation the answer is held
 * on it (`autoLandDraft`) and carried by the message that opens it; from then on it is the card's, written at once and
 * read by the daemon when the running turn, if any, finishes.
 */
export const useComposerLanding = (conversation: () => Conversation) => {
    const { agentById, setAutoLand } = useAgents();
    const { settings } = useSandboxSettings();
    const { canShip, canLandHome } = useRole();
    const sandboxLands = computed(() => landsByDefault(settings.value?.rules ?? []));
    const registered = computed(() => conversation().registered.value);
    const card = computed(() => (registered.value ? agentById(conversation().conversationId) : undefined));
    // Whether it works on a branch of its own is the card's to say once the daemon holds it (this tab's latch can be an
    // older reading), and the tab's before. A draft's answer rides its opening message, which only a sandbox that reads
    // `conversationAutoLand` takes. Never a home conversation's: it lands and commits whatever it merged by itself, and
    // its person only chats with it (the daemon's turn-landing.ts homeOverride takes no hold for one).
    const offered = computed(
        () =>
            canShip.value &&
            !isHomeConversationId(conversation().conversationId) &&
            conversation().box.value === undefined &&
            (registered.value ? card.value?.branch !== undefined : conversation().isolated.value && supportsRoute(`agent.queueSchedule`)),
    );
    // The conversation's own answer, undefined while it follows the sandbox's.
    const own = computed<boolean | undefined>(() => (registered.value ? card.value?.autoLand : conversation().autoLandDraft.value));
    const lands = computed(() => effectiveAutoLand({ autoLand: own.value }, sandboxLands.value));
    // Choosing the sandbox's own answer clears the conversation's rather than freezing a copy of it, as the board does.
    const set = (on: boolean): void => {
        const answer = on === sandboxLands.value ? undefined : on;
        if (registered.value) {
            void setAutoLand(conversation().conversationId, answer ?? null);
            return;
        }
        conversation().autoLandDraft.value = answer;
    };
    return {
        offered,
        lands,
        // Whether the answer is the conversation's own rather than the sandbox's: what puts its pill on the row.
        own: computed(() => own.value !== undefined),
        // A turn is running, so a change now holds or lands that turn's work when it finishes.
        midTurn: computed(() => card.value !== undefined && turnInFlight(card.value)),
        // A home's fixed answer, said on the row where this chat's own would be offered (ComposerLandPill).
        home: computed(() => homeLandingOf({ conversationId: conversation().conversationId, box: conversation().box.value }, canLandHome.value)),
        sandboxLands,
        set,
        toggle: (): void => set(!lands.value),
    };
};

export type ComposerLanding = ReturnType<typeof useComposerLanding>;
