import { computed } from "vue";
import { effectiveAutoLand, turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { landsByDefault } from "../../sandbox/environment/rules";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { useRole } from "../../../client/sandbox/useRole";
import type { Conversation } from "../session/conversation";

// The composer setting about how a conversation's work arrives rather than what it says: whether its finished work lands
// by itself, a standing answer of the conversation's (the board menu's "Land automatically"). Which agents a message can
// wait for is waitTargets.ts's.

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
    const { canShip } = useRole();
    const sandboxLands = computed(() => landsByDefault(settings.value?.rules ?? []));
    const registered = computed(() => conversation().registered.value);
    const card = computed(() => (registered.value ? agentById(conversation().conversationId) : undefined));
    // Whether it works on a branch of its own is the card's to say once the daemon holds it (this tab's latch can be an
    // older reading), and the tab's before. A draft's answer rides its opening message, which only a sandbox that reads
    // `conversationAutoLand` takes.
    const offered = computed(
        () =>
            canShip.value &&
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
        sandboxLands,
        set,
        toggle: (): void => set(!lands.value),
    };
};

export type ComposerLanding = ReturnType<typeof useComposerLanding>;
