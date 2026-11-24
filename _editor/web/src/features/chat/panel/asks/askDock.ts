import { type ComputedRef, computed, type InjectionKey, inject, nextTick, provide, ref, type Ref, shallowRef, watch } from "vue";
import { parentOf } from "../../../../models/agent-status/ownership";
import { agentDisplayTitle } from "../../../../models/agent-status/agentStatus-meta";
import { type ChildStanding, dockedBody, type PendingAsk, pendingAsksReader } from "../../../../models/conversations/panel/pendingAsks";
import type { ConversationView } from "../../../../models/conversations/panel/useChat-view";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import { useAgents } from "../../../../models/fleet/useAgents";
import { useNeeds } from "../../../../models/needs/useNeeds";
import { askRowIn, focusAsk, revealRow, roomAbove } from "./waitingCard";

// The least room above the footer a row is worth showing in, in px: under it the dock folds out of the way first.
const ROOM_TO_READ = 220;

// ONE PANE'S DOCK OF ASKS, shared by the dock above its composer (ChatAskDock) and the rows of its transcript
// (ChatMessageView): which asks wait, which one the dock has open, and whether it is folded. Provided by the pane, the
// one ancestor of both. A row whose card the dock carries draws a one-line stub where it was asked (ChatAskStub), so the
// same live card is never drawn twice, and its press opens the dock on it.

export interface AskDock {
    /** Every ask this chat waits on a person for, oldest first. */
    readonly asks: ComputedRef<readonly PendingAsk[]>;
    /** The ask the dock has open: the reader's pick, else, once that one is answered, the one after it. */
    readonly selected: ComputedRef<PendingAsk | undefined>;
    /** Whether the dock shows the picked ask's whole card, or every ask folded to its line. */
    readonly open: ComputedRef<boolean>;
    /** Whether this reader may answer, or only follows the chat. */
    readonly canDrive: ComputedRef<boolean>;
    readonly pick: (key: string) => void;
    readonly toggle: () => void;
    /** Whether the dock draws this ask's whole card, so the row it was asked in draws only a stub. */
    readonly holds: (key: string) => boolean;
    readonly find: (key: string) => PendingAsk | undefined;
    /** From a stub: open the dock on this ask and hand its answer the keyboard. */
    readonly answer: (key: string) => void;
    /** From the dock: the row the ask was made in, brought on screen above the footer. */
    readonly showInChat: (key: string) => Promise<void>;
    /** Answers a card the dock carries, then follows the turn it lets go on. */
    readonly reply: (requestId: string, answer: CardAnswer) => Promise<void>;
    readonly settling: (requestId: string) => boolean;
    /** The dock's own element, while it is drawn: what the presses above find the ask's body and the pane in. */
    readonly element: Ref<HTMLElement | undefined>;
}

const ASK_DOCK: InjectionKey<AskDock> = Symbol(`ask-dock`);

export interface AskDockHost {
    readonly view: ConversationView;
    readonly canDrive: () => boolean;
    /** Follows the transcript's foot again: an answer from the dock lets the turn go on, and that is what to watch. */
    readonly pin: () => void;
}

// The reader's fold, per conversation, for this window's life: switching tabs and back keeps it.
const folds = new Map<string, boolean>();

const useChildren = (conversationId: () => string): ComputedRef<readonly ChildStanding[]> => {
    const { fleet } = useAgents();
    return computed(() =>
        fleet.value
            .filter((agent) => agent.archivedAt === undefined && parentOf(agent.startedBy) === conversationId())
            .map((agent) => ({ ...agent, title: agentDisplayTitle(agent) })),
    );
};

// THE OLDEST ASK FIRST, until the reader picks one; then THE PICK STAYS PUT: a newer ask arriving leaves it open, and
// answered it gives way to the one after it, in the order asked, rather than jumping back to the top.
const usePick = (asks: ComputedRef<readonly PendingAsk[]>) => {
    const picked = ref<string | undefined>();
    let pickedAt = 0;
    watch(
        asks,
        (list) => {
            if (picked.value === undefined) {
                return;
            }
            const at = list.findIndex((ask) => ask.key === picked.value);
            if (at >= 0) {
                pickedAt = at;
                return;
            }
            picked.value = list[Math.min(pickedAt, list.length - 1)]?.key;
        },
        { immediate: true },
    );
    const choose = (key: string): void => {
        picked.value = key;
        pickedAt = Math.max(0, asks.value.findIndex((ask) => ask.key === key));
    };
    return { choose, selected: computed(() => asks.value.find((ask) => ask.key === picked.value) ?? asks.value[0]) };
};

// OPEN WHEN THE TURN IS PARKED, folded to their lines while the agent works on without the answer (a need), unless the
// reader said otherwise. A card arriving that the reader has not seen opens it again: it is the next step there is.
const useFold = (asks: ComputedRef<readonly PendingAsk[]>, conversationId: () => string) => {
    const folded = ref<boolean | undefined>(folds.get(conversationId()));
    const parked = computed(() => asks.value.some((ask) => ask.source === `card` || ask.source === `undrawn`));
    let seenCards = new Set<string>();
    watch(
        asks,
        (list) => {
            const cards = list.filter((ask) => ask.source === `card`).map((ask) => ask.key);
            if (list.length === 0 || cards.some((key) => !seenCards.has(key))) {
                folded.value = undefined;
                folds.delete(conversationId());
            }
            seenCards = new Set(cards);
        },
        { immediate: true },
    );
    const setFolded = (value: boolean): void => {
        folded.value = value;
        folds.set(conversationId(), value);
    };
    return { open: computed(() => (folded.value === undefined ? parked.value : !folded.value)), setFolded };
};

export const provideAskDock = (host: AskDockHost): AskDock => {
    const { view } = host;
    const conversationId = (): string => view.conversation.value.conversationId;
    const store = useNeeds();
    const needs = store.openFor(conversationId);
    const children = useChildren(conversationId);
    const read = pendingAsksReader();
    const asks = computed(() =>
        read(view.messages.value, {
            ended: view.ending.value !== undefined,
            needs: needs.value,
            needById: store.byId,
            children: children.value,
            waitsOn: view.waitsOn.value,
        }),
    );

    const { choose, selected } = usePick(asks);
    const { open, setFolded } = useFold(asks, conversationId);
    const element = shallowRef<HTMLElement | undefined>();
    const find = (key: string): PendingAsk | undefined => asks.value.find((ask) => ask.key === key);
    const pick = (key: string): void => {
        choose(key);
        setFolded(false);
    };
    const answer = (key: string): void => {
        const ask = find(key);
        if (ask === undefined) {
            return;
        }
        pick(key);
        void nextTick(() => {
            const body = element.value?.querySelector<HTMLElement>(`[data-ask-body]`);
            if (body !== null && body !== undefined) {
                focusAsk(body, ask.source === `need` ? `other` : ask.kind);
            }
        });
    };
    // A footer that leaves the transcript too little room to show the row in (a phone, with the dock open over its other
    // strips) folds the dock first: asking to see where an ask was made is asking for the transcript.
    const showInChat = async (key: string): Promise<void> => {
        const pane = element.value?.closest(`.chat-pane`);
        const scroller = pane?.querySelector<HTMLElement>(`.chat-scroller`);
        if (pane === null || pane === undefined || scroller === null || scroller === undefined) {
            return;
        }
        const footer = (): HTMLElement | null => pane.querySelector<HTMLElement>(`.chat-footer`);
        if (open.value && roomAbove(scroller, footer()) < ROOM_TO_READ) {
            setFolded(true);
            await nextTick();
        }
        const row = askRowIn(pane, key);
        if (row !== undefined) {
            revealRow(row, scroller, footer());
        }
    };
    const reply = async (requestId: string, choice: CardAnswer): Promise<void> => {
        if (await view.conversation.value.requests.reply(requestId, choice)) {
            host.pin();
        }
    };

    const dock: AskDock = {
        asks,
        selected,
        open,
        canDrive: computed(host.canDrive),
        pick,
        toggle: () => setFolded(open.value),
        holds: (key) => {
            const ask = element.value === undefined ? undefined : find(key);
            return ask !== undefined && dockedBody(ask);
        },
        find,
        answer,
        showInChat,
        reply,
        settling: (requestId) => view.conversation.value.requests.isReplying(requestId),
        element,
    };
    provide(ASK_DOCK, dock);
    return dock;
};

/** The pane's dock, where a pane provides one; a transcript drawn anywhere else draws its cards in full. */
export const useAskDock = (): AskDock | undefined => inject(ASK_DOCK, undefined);
