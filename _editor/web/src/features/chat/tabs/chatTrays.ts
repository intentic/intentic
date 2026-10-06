import type { SubagentSession } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import type { ChildRowsBoard } from "../../agents/board/cards/childRows";
import type { IdMatch } from "../../agents/board/idMatch";
import { useBoardTrays } from "../../agents/board/view/boardTrays";
import { withoutSteps } from "../../agents/board/view/boardScope";
import { type ChildFold, foldChildren, steadyFold } from "../../agents/board/view/childFold";
import { useSubagentRoster } from "../../agents/fleet/subagentRoster";
import { useAgents } from "../../agents/fleet/useAgents";
import { agentSeed } from "../../agents/fleet/useAgents-actions";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { runIdsInLedger, useWorkflowRuns } from "../../agents/fleet/useWorkflowRuns";
import { navigateInApp } from "../../../workbench/window/mainWindow";
import { useRouter } from "vue-router";
import { agentTabOf } from "../panel/useChat-reveal";
import { subagentOnScreen } from "../panel/subagent/subagentView";
import { summonChat } from "../run/summon";

// THE BOARD'S TRAYS, UNDER THE CHAT LIST'S CARDS. Every agent a chat's conversation started rides under that chat's card
// in the list, as it does under the card on the board: the conversations it spawned and the subagents its runtime ran
// in-process, in the same rows (ChildRows), dealt by the same fold (childFold), folds and groups and all. Read off the
// whole fleet, not the chats open in this window, since a child is its parent's whether or not its own chat was ever
// opened; and a child's own chat, when it is open, rides in its parent's tray rather than standing beside it as a card of
// its own (`ridesUnder`), for as long as the parent's card is in this list.
//
// A row's press shows the child here, in this window's chat: a spawned child's own conversation, or an in-process one's
// transcript in its parent's column (subagentView.ts).

export interface ChatTraysHost {
    // The list's filter, the board's own rule (useAgentFilter).
    readonly filter: {
        readonly active: Readonly<Ref<boolean>>;
        readonly needle: Readonly<Ref<string>>;
        readonly matchCase: Readonly<Ref<boolean>>;
        readonly matches: (agent: FleetAgent) => boolean;
    };
    readonly idMatchOf: (agent: FleetAgent) => IdMatch | undefined;
    // The chat in focus, which a tray keeps in sight inside a closed fold.
    readonly activeId: Readonly<Ref<string>>;
    // Whether a chat is on screen here: the focused one, or one holding a column.
    readonly showing: (id: string) => boolean;
    // Whether this window has the chat open, and the list's own press on an open one (its modifiers compose panes).
    readonly isOpen: (id: string) => boolean;
    readonly press: (event: MouseEvent, id: string) => void;
}

export const useChatTrays = (host: ChatTraysHost) => {
    const agents = useAgents();
    const { runs } = useWorkflowRuns();
    const roster = useSubagentRoster();
    const router = useRouter();
    const ledgerRunIds = computed(() => runIdsInLedger(runs.value));
    // The board's fold over the whole fleet, less the runs' steps, which ride in their run's row instead.
    const folded = computed<ChildFold>((previous) => steadyFold(previous, foldChildren(withoutSteps(agents.lanes.value, ledgerRunIds.value))));
    // What a tray keeps in sight inside a closed fold: the subagent this window shows, else the chat in focus.
    const ringed = computed(() => subagentOnScreen.value?.id ?? host.activeId.value);
    const trays = useBoardTrays({
        scope: {
            boardChildren: computed(() => folded.value.children),
            boardHosts: computed(() => folded.value.hosts),
            boardCalls: computed(() => folded.value.calls),
            ledgerRunIds,
        },
        archived: agents.archived,
        filter: host.filter,
        roster,
        selected: ringed,
    });

    // A spawned child: its own chat, by the list's own press when it is open here, else opened as a look, swept once the
    // reader points elsewhere, as a board press opens it.
    const open = (child: FleetAgent, event?: MouseEvent): void => {
        if (event !== undefined && host.isOpen(child.id)) {
            host.press(event, child.id);
            return;
        }
        agents.open(child, `peek`);
    };
    // An in-process one: its transcript, in its parent's column.
    const openSubagent = (card: FleetAgent, subagent: SubagentSession): void => {
        summonChat({ kind: `subagent`, parent: agentTabOf(agentSeed(card)), id: subagent.id });
        agents.markSeen(card.id);
    };

    const board: ChildRowsBoard = {
        childrenOf: trays.childrenOf,
        subagentsOf: trays.subagentsOf,
        stateOf: trays.trayState,
        toggle: trays.toggleTray,
        // A spawned child's chat on screen, or the in-process one whose transcript this window shows.
        selected: (id) => subagentOnScreen.value?.id === id || host.showing(id),
        needle: host.filter.needle,
        matchCase: host.filter.matchCase,
        idMatchOf: host.idMatchOf,
        open,
        openSubagent,
        // The child's page is the app's, reached in the window the app is in, never this one if it is the chat's own.
        review: (child) => navigateInApp(router, `/agents/${encodeURIComponent(child.id)}`),
        // Nothing moves between lanes here, so a row has no motion to join.
        setRowEl: () => {},
    };

    /**
     * Whether a chat rides in the tray of another chat in this list, rather than standing as a card of its own. `listed`
     * says which chats the list draws, every open one unless the list is scoped: a child's parent scoped out of it
     * leaves the child standing on its own rather than riding under a card nobody can see.
     */
    const ridesUnder = (agent: FleetAgent | undefined, listed: (id: string) => boolean = host.isOpen): boolean => {
        if (agent === undefined) {
            return false;
        }
        const card = trays.cardOf(agent);
        return card !== agent && listed(card.id);
    };
    return { board, ridesUnder, answers: trays.answers };
};
