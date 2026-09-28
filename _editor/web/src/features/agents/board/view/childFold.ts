import type { SubagentSession } from "@intentic/sandbox-contract";
import { callsOwner, type FleetLane, laneOf, limited, onlyOwnerCanAnswer, unregistered } from "../../fleet/agentStatus";
import { subagentLive } from "../../fleet/subagentRoster";
import { activeLaneOrder, attentionLaneOrder, type FleetAgent, finishedNeedsReland } from "../../fleet/useAgents-fleet";
import { parentOf } from "../ownership";

// CHILDREN RIDE UNDER THEIR PARENT. A conversation another one spawned (`startedBy: agent:<id>`) is drawn as a slim row
// under the card of the conversation that started it, never as a card of its own while that card is on the board: an
// orchestrator that delegates to thirty children otherwise fills the board with thirty cards telling one story, and the
// story's own card is lost among them. What a child stops on is its parent's news first, as the sandbox routes it (its
// ending is reported to its parent, and a question is the parent's to answer), so a stop only reaches the reader when it
// is theirs to answer (callsOwner), and then the parent's card carries it: the card moves to the lane that asks, as a
// workflow run's card does for its steps (useWorkflowRuns.laneOfRun). Pure over the lanes, as withoutSteps is, so every
// count, window and range the board reads is taken from the cards it actually draws.
//
// A CARD'S TRAY HOLDS EVERY AGENT IT STARTED, whichever mechanism started it. A conversation it spawned rides here from
// the fold; a subagent its own runtime ran in-process (the roster's `subagent` kind: the runtime's Agent/Task tool) has no
// conversation, so it never reaches the fold as a card, and joins the tray from the roster, dealt by the same rules into
// the same rows. What it asks of the reader it asks through its parent's own turn, whose card already carries it.

// Most urgent first: a family stands in the most urgent lane any of it asks for.
const URGENCY = { attention: 0, active: 1, finished: 2 } as const satisfies Record<FleetLane, number>;

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

// A child keeps a card of its own only for a press a row cannot carry: a land owed or under way, landed work the
// workspace no longer holds, words left in its composer. Whatever it asks of the reader rides up on its parent's card
// instead (callsOwner), and a draft has no record to ride with.
export const standsAlone = (agent: FleetAgent): boolean =>
    unregistered(agent.status) || agent.status === `ready` || agent.status === `landing` || finishedNeedsReland(agent) || agent.unsent;

// How a fold treats the children it meets: which keep a card wherever their parent is, and which call the reader through
// their parent's card, given the lanes both were dealt.
export interface FoldRules {
    readonly alone: (agent: FleetAgent) => boolean;
    readonly calls: (child: FleetAgent, lanes: { readonly child: FleetLane; readonly parent: FleetLane }) => boolean;
}

export const BOARD_RULES: FoldRules = { alone: standsAlone, calls: callsOwner };

// The archive's: every filed child rides under its filed parent, and none calls, since every press there is withheld
// until a card is restored and so nothing is asking.
export const ARCHIVE_RULES: FoldRules = { alone: () => false, calls: () => false };

// A card's key across boxes: an id is one daemon's, and the all-sandboxes board holds several daemons' cards. A parent
// always lives in its child's own box, so the child's box is the one its parent's id is read in.
const keyOf = (id: string, sandboxId: string | undefined): string => (sandboxId === undefined ? id : `${sandboxId}\u0000${id}`);
export const cardKey = (agent: Pick<FleetAgent, `id` | `sandboxId`>): string => keyOf(agent.id, agent.sandboxId);

// The board's three columns of cards, as laneGroups deals them.
export interface Lanes {
    attention: FleetAgent[];
    active: FleetAgent[];
    finished: FleetAgent[];
}

export interface ChildFold {
    // The lanes less every child riding under a card, each card in the lane its family asks for: what the board draws.
    readonly lanes: Lanes;
    // What rides under each card, by its cardKey: the calling children first, then working ones as Active orders them,
    // then settled ones as Finished does, newest first. A grandchild rides under the same card as its parent does.
    readonly children: ReadonlyMap<string, readonly FleetAgent[]>;
    // The card each riding child is drawn under, by the child's cardKey.
    readonly hosts: ReadonlyMap<string, FleetAgent>;
    // The children under each card that call the reader through it (callsOwner), by its cardKey, in the same order.
    readonly calls: ReadonlyMap<string, readonly FleetAgent[]>;
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

const noLanes = (): Lanes => ({ attention: [], active: [], finished: [] });

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key);
    if (list === undefined) {
        map.set(key, [value]);
    } else {
        list.push(value);
    }
};

// Where a card lifted by its family sits in the lane it was lifted to, read as that lane's own order would read it: in
// Attention by its children's newest call, in Active by the start of the earliest work in flight under it.
interface Lift {
    lane: FleetLane;
    calledAt: number;
    workingSince: number;
}

const ordered = (cards: FleetAgent[], order: (a: FleetAgent, b: FleetAgent) => number, probe: (card: FleetAgent) => FleetAgent): FleetAgent[] =>
    cards
        .map((card) => ({ card, probe: probe(card) }))
        .sort((a, b) => order(a.probe, b.probe))
        .map((entry) => entry.card);

export const foldChildren = (lanes: Lanes, rules: FoldRules = BOARD_RULES): ChildFold => {
    const where = new Map<string, { readonly agent: FleetAgent; readonly lane: FleetLane }>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            where.set(cardKey(agent), { agent, lane });
        }
    }
    const parentKeyOf = (agent: FleetAgent): string | undefined => {
        const parentId = parentOf(agent.startedBy);
        return parentId === undefined ? undefined : keyOf(parentId, agent.sandboxId);
    };
    // The card a conversation rides under, `undefined` for one that is a card itself. Memoised, and walked with the
    // path it came by, so a record naming its own descendant as its parent ends the walk instead of looping.
    const hostKeys = new Map<string, string | undefined>();
    const hostOf = (key: string, path: ReadonlySet<string>): string | undefined => {
        if (hostKeys.has(key)) {
            return hostKeys.get(key);
        }
        const self = where.get(key);
        const parentKey = self === undefined ? undefined : parentKeyOf(self.agent);
        const host =
            self !== undefined && parentKey !== undefined && where.has(parentKey) && !path.has(parentKey) && !rules.alone(self.agent)
                ? (hostOf(parentKey, new Set([...path, key])) ?? parentKey)
                : undefined;
        hostKeys.set(key, host);
        return host;
    };
    const children = new Map<string, FleetAgent[]>();
    const calls = new Map<string, FleetAgent[]>();
    const hosts = new Map<string, FleetAgent>();
    const lifts = new Map<string, Lift>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            const key = cardKey(agent);
            const host = hostOf(key, new Set());
            const hostEntry = host === undefined ? undefined : where.get(host);
            // A rider's parent is on the board by construction: a child whose parent is not stands as its own card.
            const parent = where.get(parentKeyOf(agent) ?? ``);
            if (host === undefined || hostEntry === undefined || parent === undefined) {
                continue;
            }
            push(children, host, agent);
            hosts.set(key, hostEntry.agent);
            const calling = rules.calls(agent, { child: lane, parent: parent.lane });
            if (calling) {
                push(calls, host, agent);
            }
            // What this child asks of its family's lane: the reader's when it calls them, Active while it is in flight
            // or stopped under a parent still supervising it, nothing more than the ledger once it has settled.
            const wants: FleetLane = calling ? `attention` : lane === `finished` ? `finished` : `active`;
            const lift = lifts.get(host) ?? { lane: hostEntry.lane, calledAt: 0, workingSince: Number.POSITIVE_INFINITY };
            lifts.set(host, {
                lane: URGENCY[wants] < URGENCY[lift.lane] ? wants : lift.lane,
                calledAt: calling ? Math.max(lift.calledAt, agent.updatedAt) : lift.calledAt,
                workingSince: lane === `active` ? Math.min(lift.workingSince, agent.startedAt ?? agent.updatedAt) : lift.workingSince,
            });
        }
    }
    // Nothing rode anywhere, which is most boards: the lanes go on as they came, so nothing downstream recomputes.
    if (hosts.size === 0) {
        return { lanes, children: EMPTY, hosts: EMPTY, calls: EMPTY };
    }
    const cards = noLanes();
    const lifted = new Map<FleetAgent, Lift>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            const key = cardKey(agent);
            if (hosts.has(key)) {
                continue;
            }
            const lift = lifts.get(key);
            if (lift !== undefined && lift.lane !== lane) {
                lifted.set(agent, lift);
                cards[lift.lane].push(agent);
            } else {
                cards[lane].push(agent);
            }
        }
    }
    // A lane a card was lifted into is put back in its own order, the lifted card read by its family's clock.
    if (lifted.size > 0) {
        cards.attention = ordered(cards.attention, attentionLaneOrder, (card) => {
            const lift = lifted.get(card);
            return lift === undefined ? card : { ...card, updatedAt: lift.calledAt };
        });
        cards.active = ordered(cards.active, activeLaneOrder, (card) => {
            const lift = lifted.get(card);
            return lift === undefined || !Number.isFinite(lift.workingSince) ? card : { ...card, startedAt: lift.workingSince };
        });
    }
    return { lanes: cards, children, hosts, calls };
};

const sameMembers = <T>(left: readonly T[] | undefined, right: readonly T[]): boolean =>
    left !== undefined && left.length === right.length && left.every((entry, at) => entry === right[at]);

// The last answer's list for each key wherever the new answer holds the same members in the same order.
const steadyMap = (
    previous: ReadonlyMap<string, readonly FleetAgent[]>,
    next: ReadonlyMap<string, readonly FleetAgent[]>,
): ReadonlyMap<string, readonly FleetAgent[]> => {
    const kept = new Map<string, readonly FleetAgent[]>();
    for (const [key, list] of next) {
        const before = previous.get(key);
        kept.set(key, before !== undefined && sameMembers(before, list) ? before : list);
    }
    const still = kept.size === previous.size && [...kept].every(([key, list]) => previous.get(key) === list);
    return still ? previous : kept;
};

// The last answer's arrays wherever the new answer holds the same cards in the same order, and the last answer whole
// when nothing moved, so a roster tick that moved one card redraws that card's lane and tray and no other: a tray reads
// its list through a computed, which only wakes its readers when the list itself is a different one.
export const steadyFold = (previous: ChildFold | undefined, next: ChildFold): ChildFold => {
    if (previous === undefined) {
        return next;
    }
    const keep = (lane: FleetLane): FleetAgent[] => (sameMembers(previous.lanes[lane], next.lanes[lane]) ? previous.lanes[lane] : next.lanes[lane]);
    const kept = { attention: keep(`attention`), active: keep(`active`), finished: keep(`finished`) };
    const lanesStill = LANES.every((lane) => kept[lane] === previous.lanes[lane]);
    const children = steadyMap(previous.children, next.children);
    const calls = steadyMap(previous.calls, next.calls);
    // The same cards in every lane and tray means the same card under each child, so the hosts are the last answer's too.
    if (lanesStill && children === previous.children && calls === previous.calls) {
        return previous;
    }
    return { lanes: lanesStill ? previous.lanes : kept, children, hosts: next.hosts, calls };
};

// The settled children's fold, in the set of folds a card's tray has open.
export const FINISHED_FOLD = `finished`;

// What a stopped child stopped on, as its tray groups them: a spent allowance by the provider it ran on, since that
// provider's window reopens for all of them at once, and anything else by its standing.
export const stopOf = (child: FleetAgent): string => {
    if (limited(child)) {
        return `limit:${child.provider}`;
    }
    if (child.attention.question) {
        return `question`;
    }
    return child.attention.conflict || child.status === `conflict` ? `conflict` : child.status;
};

// Groups in a fixed order, so a tray never reshuffles as its children tick: the stops that clear by themselves first.
const STOP_RANK: Readonly<Record<string, number>> = { error: 1, interrupted: 2, stopping: 3, stopped: 3, question: 4, conflict: 5 };
const stopRank = (key: string): number => (key.startsWith(`limit:`) ? 0 : (STOP_RANK[key] ?? 6));

// A row in a card's tray: a conversation the card spawned, or a subagent its runtime ran in-process.
export type TrayChild = FleetAgent | SubagentSession;

// The roster's record, not a conversation: no card, chat, branch or menu of its own. Only the roster's shape carries the
// conversation that started it.
export const inProcess = (child: TrayChild): child is SubagentSession => `conversationId` in child;

// What an in-process subagent is called on its row: the one-line ask, else the kind of subagent it ran as.
export const subagentTitle = (session: Pick<SubagentSession, "description" | "agentType">): string | undefined =>
    [session.description, session.agentType].find((part) => part !== undefined && part.trim() !== ``);

// The clocks both kinds are dealt by: when it started, as Active orders its cards, and when it settled, as Finished does.
const startOf = (child: TrayChild): number => (inProcess(child) ? child.startedAt : (child.startedAt ?? child.updatedAt));
const settledAt = (child: TrayChild): number => (inProcess(child) ? (child.endedAt ?? child.activityAt) : child.updatedAt);

// Two lists, each already in its own order, woven into one by a clock, so neither kind's order is disturbed and neither
// is drawn after the other as an afterthought. `first` says whether the left one's head goes before the right one's.
const weave = (left: readonly TrayChild[], right: readonly TrayChild[], first: (a: TrayChild, b: TrayChild) => boolean): TrayChild[] => {
    const woven: TrayChild[] = [];
    let at = 0;
    for (const child of right) {
        while (at < left.length && first(left[at]!, child)) {
            woven.push(left[at]!);
            at += 1;
        }
        woven.push(child);
    }
    return [...woven, ...left.slice(at)];
};

// Children stopped on one thing, drawn as one row that unfolds into theirs.
export interface TrayGroup {
    // What they stopped on (stopOf), which is also the fold's name in the card's open folds.
    readonly key: string;
    readonly members: readonly FleetAgent[];
    readonly open: boolean;
    // Drawn under the group's row: every member while it is open or when it is one child alone, else only the one
    // wearing the ring, which stays in sight wherever it is.
    readonly shown: readonly FleetAgent[];
}

// What a card's tray draws, top to bottom.
export interface Tray {
    // Children asking what only the reader can give (onlyOwnerCanAnswer), each wearing its ask: always in sight. Only a
    // conversation asks: an in-process subagent asks through its parent's turn, on the card itself.
    readonly asks: readonly FleetAgent[];
    // Every working child of either kind, the earliest started first as Active orders its cards; or while a filter is on,
    // every child it matched.
    readonly lead: readonly TrayChild[];
    // Children stopped on something that is their parent's news first, a row per thing they stopped on.
    readonly groups: readonly TrayGroup[];
    // Settled children of either kind behind the toggle; nothing is folded while a filter is on, since a result set must
    // not hide its own matches.
    readonly folded: number;
    readonly open: boolean;
    // Drawn under the toggle: all of the settled children while it is open, newest first as Finished orders its cards,
    // else only the one wearing the ring, which stays in sight wherever it is, as the Finished window keeps its selection
    // (windowFinished).
    readonly tail: readonly TrayChild[];
}

export interface TrayState {
    // The folds the reader opened on this card: FINISHED_FOLD for its settled children, a stop's key for its group.
    readonly opened: ReadonlySet<string>;
    // Whether anything under this card may ask: never in the archive, where every press waits for a restore.
    readonly asking: boolean;
    readonly filtering: boolean;
    readonly matches: (agent: FleetAgent) => boolean;
    // The same question of an in-process subagent, which only its title can answer.
    readonly matchesSubagent: (session: SubagentSession) => boolean;
    readonly selected: string | undefined;
}

const NO_SUBAGENTS: readonly SubagentSession[] = [];

// A tray's working and settled rows, the conversations' and the in-process subagents' dealt together by the same clocks.
interface Dealt {
    readonly lead: readonly TrayChild[];
    readonly settled: readonly TrayChild[];
}

const withSubagents = (lead: readonly FleetAgent[], settled: readonly FleetAgent[], subagents: readonly SubagentSession[]): Dealt => {
    const working = subagents.filter(subagentLive).toSorted((a, b) => a.startedAt - b.startedAt);
    const done = subagents.filter((session) => !subagentLive(session)).toSorted((a, b) => settledAt(b) - settledAt(a));
    return {
        lead: weave(lead, working, (a, b) => startOf(a) <= startOf(b)),
        settled: weave(settled, done, (a, b) => settledAt(a) >= settledAt(b)),
    };
};

// A tray is only drawn with something in it: a card whose children the filter all passed over has none. `children` are
// the conversations riding under the card (the fold's), `subagents` the ones its runtime ran in-process (the roster's).
export const trayOf = (
    children: readonly FleetAgent[] | undefined,
    state: TrayState,
    subagents: readonly SubagentSession[] = NO_SUBAGENTS,
): Tray | undefined => {
    const riders = children ?? [];
    if (riders.length === 0 && subagents.length === 0) {
        return undefined;
    }
    if (state.filtering) {
        const lead = [...riders.filter(state.matches), ...subagents.filter(state.matchesSubagent)];
        return lead.length === 0 ? undefined : { asks: [], lead, groups: [], folded: 0, open: false, tail: [] };
    }
    const asks: FleetAgent[] = [];
    const lead: FleetAgent[] = [];
    const settled: FleetAgent[] = [];
    const stops = new Map<string, FleetAgent[]>();
    for (const child of riders) {
        const lane = laneOf(child);
        if (state.asking && onlyOwnerCanAnswer(child)) {
            asks.push(child);
        } else if (lane === `active`) {
            lead.push(child);
        } else if (lane === `finished`) {
            settled.push(child);
        } else {
            push(stops, stopOf(child), child);
        }
    }
    const groups = [...stops]
        .sort(([a], [b]) => stopRank(a) - stopRank(b) || (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, members]): TrayGroup => {
            const open = state.opened.has(key);
            return { key, members, open, shown: open || members.length === 1 ? members : members.filter((child) => child.id === state.selected) };
        });
    const dealt = withSubagents(lead, settled, subagents);
    const open = state.opened.has(FINISHED_FOLD);
    const tail = open ? dealt.settled : dealt.settled.filter((child) => child.id === state.selected);
    return { asks, lead: dealt.lead, groups, folded: dealt.settled.length, open, tail };
};

// The conversations a tray draws, top to bottom, for anything that walks the board in drawing order (a Shift+click
// range): an in-process subagent has no chat of its own to open in a pane.
export const trayRows = (tray: Tray | undefined): readonly FleetAgent[] =>
    tray === undefined
        ? []
        : [...tray.asks, ...tray.lead, ...tray.groups.flatMap((group) => group.shown), ...tray.tail].filter(
              (child): child is FleetAgent => !inProcess(child),
          );
