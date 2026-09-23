import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, onScopeDispose, ref, type Ref, watch } from "vue";
import type { LocationQuery, Router } from "vue-router";
import { clickIntent, rangeSelect } from "../../../../lib/multiSelect";
import { uuid } from "../../../../lib/uuid";
import { agentTabOf } from "../../../chat/panel/useChat-reveal";
import { showingRunGraph } from "../../../chat/run/chatRun";
import { traceFocus } from "../../../chat/run/focusTrace";
import type { Summons } from "../../../chat/run/summon";
import type { Strip } from "../../../chat/tabs/tabFacts";
import { isRemote } from "../../fleet/fleetScope";
import { agentSeed } from "../../fleet/useAgents-actions";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import type { ViewEvent } from "./boardView";

// Which card the board points at and what a press on one does: the ring follows the chat's own selection unless a link
// just focused a card, a click is a look rather than a navigation, a modified click composes panes, and a link uncovers
// its card. Every gesture is a summons, since the panel it composes may be another window's.

// The keys that turn a click on a card into a pane gesture.
export type PaneKeys = Pick<MouseEvent, `shiftKey` | `altKey` | `ctrlKey` | `metaKey`>;

// The chat rail's gestures (ChatTabList.onRowClick): Shift a range, Alt a column beside (only ever adding), Ctrl/Cmd a
// column toggled among several; Alt rather than bare Ctrl, which is macOS's secondary click on a card that also drags.
export const paneAsk = (keys: PaneKeys, shown: boolean, several: boolean): `range` | `beside` | `unpane` | undefined => {
    const intent = clickIntent(keys);
    if (intent === `range`) {
        return `range`;
    }
    if (intent === `toggle` && !keys.altKey && shown && several) {
        return `unpane`;
    }
    return intent === `toggle` || keys.altKey ? `beside` : undefined;
};

// The cards a Shift+click range covers in the order they are drawn (rangeSelect), matched by id.
export const paneRange = (order: readonly FleetAgent[], anchor: string | undefined, agent: FleetAgent): FleetAgent[] => {
    const ids = rangeSelect(
        order.map((card) => card.id),
        anchor,
        agent.id,
    );
    return ids === undefined ? [agent] : order.filter((card) => ids.includes(card.id));
};

export interface RingHost {
    readonly mobile: Readonly<Ref<boolean>>;
    // The app-wide chat strip, never this window's own tab list, which is a stale shadow once the chat is popped out.
    readonly strip: Readonly<Ref<Strip>>;
    // The chat drawn wide, the only form that shows a run's diagram; the docked panel always shows the focused chat.
    readonly wide: Readonly<Ref<boolean>>;
    readonly runs: Readonly<Ref<readonly WorkflowRun[]>>;
}

// How long a link's ring stays on the card it focused (ms).
const FOCUS_FLASH_MS = 4_000;

// The ring: the docked chat's card on desktop, or for a while the one a link just focused. Board-wide state, not a
// paint, since the Finished window and cross-board selections read it too.
export const useCardRing = (host: RingHost) => {
    const { mobile, strip } = host;
    const flashId = ref<string | undefined>(undefined);
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const flash = (id: string): void => {
        flashId.value = id;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => (flashId.value = undefined), FOCUS_FLASH_MS);
    };
    onScopeDispose(() => clearTimeout(flashTimer));
    // A run's diagram points the chat at no one conversation; the panel's own predicate, a followed run drawing it too.
    const runGraphUp = computed(
        () =>
            host.wide.value &&
            showingRunGraph(
                host.runs.value.find((run) => run.runId === strip.value.run?.runId),
                strip.value.run,
                strip.value.panes,
            ),
    );
    const highlightId = computed(() => flashId.value ?? (mobile.value || runGraphUp.value ? undefined : strip.value.active));
    // Other panes wear a fainter ring, a split being chats read side by side rather than a ranking; cleared by the same
    // states as the ring.
    const inPane = (id: string): boolean => {
        const { panes: shown } = strip.value;
        return !mobile.value && !runGraphUp.value && shown.length > 1 && shown.includes(id);
    };
    // Whether the chat is open only as a look (TabFacts.peek); desktop only, since a phone's tab set is one deep.
    const peeked = (id: string): boolean => !mobile.value && strip.value.tabs.some((tab) => tab.id === id && tab.peek);
    return { flashId, highlightId, inPane, peeked, flash };
};

export interface FocusHost {
    readonly ring: {
        readonly flashId: Ref<string | undefined>;
        readonly highlightId: Readonly<Ref<string | undefined>>;
        readonly flash: (id: string) => void;
    };
    readonly lanes: {
        readonly paneOrder: Readonly<Ref<readonly FleetAgent[]>>;
        readonly finishedWindow: Readonly<Ref<{ readonly shown: readonly FleetAgent[] }>>;
    };
    readonly filter: {
        readonly active: Readonly<Ref<boolean>>;
        readonly matches: (agent: FleetAgent) => boolean;
        readonly query: Ref<string>;
        readonly sessionMatches: Readonly<Ref<readonly { readonly id: string; readonly title: string }[]>>;
    };
    readonly agents: {
        readonly open: (agent: FleetAgent, mode?: `peek` | `keep`) => void;
        readonly markSeen: (id: string) => void;
        readonly agentById: (id: string) => FleetAgent | undefined;
    };
    // A drag's pointerup lands as a click on the card it started from, which must not also open it (useAgentDrag).
    readonly drag: { readonly consumeSuppressedOpen: () => boolean };
    readonly move: (event: ViewEvent) => void;
    // Scrolls a card into view once it is drawn.
    readonly reveal: (id: string) => Promise<void>;
    readonly router: Router;
    readonly route: { readonly query: LocationQuery };
    readonly mobile: Readonly<Ref<boolean>>;
    readonly strip: Readonly<Ref<Strip>>;
    readonly summon: (summons: Summons) => void;
}

// What a press on a card does, and what a link to one does. A click focuses rather than navigates: it points the chat at
// the card and rings it, cheap and reversible, so clicking down a lane is skimming; a phone has no dock and navigates.
export const useCardFocus = (host: FocusHost) => {
    const { ring, agents, filter, router, route, mobile, strip, summon } = host;
    // The card a Shift+click range runs from: the last one clicked here, else the chat's own.
    let paneAnchor: string | undefined;
    // A selection this board made itself, so the reveal below stands down for the card already under the cursor.
    let selectedHere: string | undefined;

    const summonCards = (verb: `beside` | `panes`, cards: readonly FleetAgent[], focus: string): void => {
        summon({ kind: `reveal`, verb, entries: cards.map((card) => agentTabOf(agentSeed(card))), focus, caret: false });
        for (const card of cards) {
            agents.markSeen(card.id);
        }
    };
    // At N panes, what's selected IS what's on screen, so a modified click gives that chat a column there.
    const paneGesture = (agent: FleetAgent, event: MouseEvent): boolean => {
        const ask = paneAsk(event, strip.value.panes.includes(agent.id), strip.value.panes.length > 1);
        if (ask === undefined) {
            return false;
        }
        if (ask === `range`) {
            summonCards(`panes`, paneRange(host.lanes.paneOrder.value, paneAnchor ?? strip.value.active, agent), agent.id);
            return true;
        }
        paneAnchor = agent.id;
        if (ask === `unpane`) {
            summon({ kind: `reveal`, verb: `unpane`, entries: [], focus: agent.id, caret: false });
            return true;
        }
        summonCards(`beside`, [agent], agent.id);
        return true;
    };

    const agentPath = (agent: FleetAgent): string => `/agents/${encodeURIComponent(agent.id)}`;
    // The agent's page, and for another box's card that box's, which the page reads from `?sandbox=`.
    const agentHref = (agent: FleetAgent): string =>
        router.resolve(isRemote(agent) ? { path: agentPath(agent), query: { sandbox: agent.sandboxId } } : agentPath(agent)).href;
    // Keeps a chat this board only opened for a look. A summons: the tab lives in whichever window draws the chat, and a
    // local promotion alone would be swept on that window's next focus move.
    const keepAgent = (agent: FleetAgent): void => {
        summon({ kind: `keep`, conversationIds: [agent.id] });
    };
    // The deliberate view change: points the chat at the agent and walks to its page, which makes the look a keep.
    const reviewAgent = (agent: FleetAgent): void => {
        // Another box's card mints no tab, which would file into the chat pointed at THIS daemon; its page reaches that box.
        if (isRemote(agent)) {
            void router.push({ path: agentPath(agent), query: { sandbox: agent.sandboxId } });
            return;
        }
        agents.open(agent);
        keepAgent(agent);
        void router.push(agentPath(agent));
    };
    const focusAgent = (agent: FleetAgent, event?: MouseEvent): void => {
        if (host.drag.consumeSuppressedOpen()) {
            return;
        }
        // The docked chat cannot point across sandboxes, so another box's card opens its review, where the crossing lives.
        if (isRemote(agent)) {
            reviewAgent(agent);
            return;
        }
        // The reader is pointing the board somewhere themselves, so whatever a link was ringing is over.
        ring.flashId.value = undefined;
        selectedHere = agent.id;
        // The head of the focus trace (focusTrace.ts): the click itself, before anything downstream can move it.
        traceFocus(`board-click`, { id: agent.id, status: agent.status });
        if (event !== undefined && !mobile.value && paneGesture(agent, event)) {
            return;
        }
        paneAnchor = agent.id;
        // The reset the modifiers are defined against (`show` collapses any split), opened as a look (Conversation.peek).
        agents.open(agent, `peek`);
        if (mobile.value) {
            void router.push(agentPath(agent));
        }
    };
    // The board's ×, the only exit for a card with no registry entry: ends the conversation everywhere, words and all,
    // unlike the chat rail's ×, which only takes a chat off that surface and sets its words aside.
    const closeAgent = (agent: FleetAgent): void => {
        summon({ kind: `close`, conversationIds: [agent.id] });
    };
    // A conversation no card stands for opens as an ordinary tab.
    const openSession = (id: string): void => {
        const conversationId = uuid();
        summon({
            kind: `reveal`,
            verb: `show`,
            entries: [{ conversationId, sessionRef: id, title: filter.sessionMatches.value.find((session) => session.id === id)?.title }],
            focus: conversationId,
            caret: false,
        });
    };

    // A selection made off the board (a chat tab, History) scrolls to its card: a ring out of view reads as a dead click.
    watch(ring.highlightId, (id) => {
        // Consumed on sight: the mark is about one selection, not a standing claim.
        const ours = id === selectedHere;
        selectedHere = undefined;
        if (id === undefined || ours) {
            return;
        }
        void host.reveal(id);
    });

    // Another surface hands a just-started agent over as `?focus=<id>`, a fresh turn having no diff yet to review.
    const requestedFocus = ref<string | undefined>(undefined);
    watch(
        () => route.query[`focus`],
        (value) => {
            if (typeof value === `string` && value !== ``) {
                requestedFocus.value = value;
            }
        },
        { immediate: true },
    );
    // Waits for the card, which can arrive after its id; one-shot, so a reload or Back doesn't re-focus a card left since.
    watch(
        () => (requestedFocus.value === undefined ? undefined : agents.agentById(requestedFocus.value)),
        async (agent) => {
            if (agent === undefined) {
                return;
            }
            requestedFocus.value = undefined;
            void router.replace({ query: { ...route.query, focus: undefined } });
            // Uncovers the card: the window lifts itself only for a ring, which a phone loses with the flash.
            if (filter.active.value && !filter.matches(agent)) {
                filter.query.value = ``;
            }
            if (agent.archivedAt !== undefined) {
                host.move({ kind: `uncover`, into: `archive` });
            } else if (mobile.value && !host.lanes.finishedWindow.value.shown.some((candidate) => candidate.id === agent.id)) {
                host.move({ kind: `uncover`, into: `lane` });
            }
            agents.open(agent);
            ring.flash(agent.id);
            // Here, not through the selection watch: a link may name the card the chat already points at, moving no ring.
            await host.reveal(agent.id);
        },
        { immediate: true },
    );

    return { focusAgent, reviewAgent, keepAgent, closeAgent, agentHref, openSession };
};
