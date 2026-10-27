import { automationOf, movedAt, stackHeads } from "@intentic/sandbox-contract/models/agent-stack";
import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import { callsOwner, type FleetLane, laneOf, runCallsOwner } from "../../agent-status/agentStatus-lanes";
import { heardByParent, limited, onlyOwnerCanAnswer, unregistered } from "../../agent-status/agentStatus-standing";
import { subagentLive } from "../subagentRoster";
import { attentionLaneOrder, type FleetAgent, finishedNeedsReland } from "../useAgents-fleet";
import { type ActiveReading, activeOrderBy, joinReadings, ownReading } from "./activePhase";
import { parentOf } from "../../agent-status/ownership";

// Fold spawned conversations under their visible parent; callsOwner promotes only reader-owned stops to the parent's lane.
// Stack earlier automation runs under the latest; they call the reader until superseded, but work awaiting land keeps a separate card.
// Archiving a card files its whole stack. Runtime in-process subagents join the same tray from the roster, not as conversation cards.
// Keep folding pure over lanes so counts, windows and ranges describe the cards actually drawn.

// Most urgent first: a family stands in the most urgent lane any of it asks for.
const URGENCY = { attention: 0, active: 1, finished: 2 } as const satisfies Record<FleetLane, number>;

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

// A child keeps a card of its own only for a press a row cannot carry: a land owed or under way, landed work the
// workspace no longer holds, words left in its composer. Whatever it asks of the reader rides up on its parent's card
// instead (callsOwner), and a draft has no record to ride with. A fresh session does: the work it was opened on, which
// this browser holds from the press that opened it (useAgents-fleet.linkedDraft). So it rides that work's card from its
// first draft, through a send the sandbox refused, and with the person's words in its composer, which is its ordinary
// state rather than a press a row cannot carry; only a land keeps a card of its own.
export const standsAlone = (agent: FleetAgent): boolean =>
    agent.status === `ready` ||
    agent.status === `landing` ||
    finishedNeedsReland(agent) ||
    (agent.fresh === undefined && (unregistered(agent.status) || agent.unsent));

// How a fold treats the children it meets: which keep a card wherever their parent is, and which call the reader through
// their parent's card, given the lanes both were dealt.
export interface FoldRules {
    readonly alone: (agent: FleetAgent) => boolean;
    readonly calls: (child: FleetAgent, family: { readonly child: FleetLane; readonly parent: FleetLane; readonly parentAt: number }) => boolean;
    // The same question of an automation's earlier run, riding the card of its latest.
    readonly runCalls: (run: FleetAgent, stack: { readonly run: FleetLane; readonly headAt: number }) => boolean;
}

export const BOARD_RULES: FoldRules = { alone: standsAlone, calls: callsOwner, runCalls: runCallsOwner };

// The archive's: every filed child rides under its filed parent, and none calls, since every press there is withheld
// until a card is restored and so nothing is asking.
export const ARCHIVE_RULES: FoldRules = { alone: () => false, calls: () => false, runCalls: () => false };

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
    // How each Active card a family rides reads there (activePhase.familyReading), by its cardKey: the most urgent work
    // in the family, its own included where its own standing is Active. A card with no riders reads as itself.
    readonly families: ReadonlyMap<string, ActiveReading>;
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
// Attention by its children's newest call, in Active by the most urgent work the family holds (joinReadings).
interface Lift {
    lane: FleetLane;
    calledAt: number;
    family: ActiveReading | undefined;
}

const ordered = (cards: FleetAgent[], order: (a: FleetAgent, b: FleetAgent) => number, probe: (card: FleetAgent) => FleetAgent): FleetAgent[] =>
    cards
        .map((card) => ({ card, probe: probe(card) }))
        .sort((a, b) => order(a.probe, b.probe))
        .map((entry) => entry.card);

// A family's lift once one more of its riding children is read into it. What the child asks of the family's lane: the
// reader's when it calls them, Active while it is in flight or stopped under a parent still supervising it, nothing
// more than the ledger once it has settled, or once its parent has moved past its stop (heardByParent), which leaves
// the card where its own standing puts it. A draft not sent yet (a fresh session being written) asks nothing either:
// nothing runs, and the card it was opened from stays where it stood rather than jumping lanes under the reader's press.
const liftWith = (lift: Lift, child: FleetAgent, read: { readonly lane: FleetLane; readonly calling: boolean; readonly heard: boolean }): Lift => {
    const drafted = child.status === `draft`;
    const wants: FleetLane = read.calling ? `attention` : read.lane === `finished` || read.heard || drafted ? `finished` : `active`;
    return {
        lane: URGENCY[wants] < URGENCY[lift.lane] ? wants : lift.lane,
        calledAt: read.calling ? Math.max(lift.calledAt, child.updatedAt) : lift.calledAt,
        family: wants === `active` ? joinReadings(lift.family, ownReading(child)) : lift.family,
    };
};

// The key of the card a conversation's parent wears, given every conversation on the board: a child's parent, or for an
// automation's earlier run the latest run of it, whose card it rides. Undefined for a conversation that rides nothing. A
// stack is keyed by the automation within its own box, since two sandboxes may name an automation alike, and a
// conversation another one started rides its parent, never a stack.
const parentKeys = (agents: readonly FleetAgent[]): ((agent: FleetAgent) => string | undefined) => {
    const runOf = (agent: FleetAgent): string | undefined => {
        const automation = parentOf(agent.startedBy) === undefined ? automationOf(agent) : undefined;
        return automation === undefined ? undefined : keyOf(automation, agent.sandboxId);
    };
    const heads = stackHeads(agents, runOf);
    return (agent) => {
        const parentId = parentOf(agent.startedBy);
        if (parentId !== undefined) {
            return keyOf(parentId, agent.sandboxId);
        }
        const stack = runOf(agent);
        const head = stack === undefined ? undefined : heads.get(stack);
        return head === undefined || head === agent ? undefined : cardKey(head);
    };
};

// Whether a riding conversation calls the reader through its card, and the moment its card last moved, past which its
// stop is heard. A child answers to its parent first (callsOwner); an automation's earlier run to nobody but the
// reader, until a later run moved past it (runCallsOwner), measured from the later run's movedAt.
const riderCall = (
    rules: FoldRules,
    agent: FleetAgent,
    lane: FleetLane,
    parent: { readonly agent: FleetAgent; readonly lane: FleetLane },
) => {
    if (parentOf(agent.startedBy) === undefined) {
        const headAt = movedAt(parent.agent);
        return { calling: rules.runCalls(agent, { run: lane, headAt }), parentAt: headAt };
    }
    const parentAt = parent.agent.updatedAt;
    return { calling: rules.calls(agent, { child: lane, parent: parent.lane, parentAt }), parentAt };
};

export const foldChildren = (lanes: Lanes, rules: FoldRules = BOARD_RULES): ChildFold => {
    const where = new Map<string, { readonly agent: FleetAgent; readonly lane: FleetLane }>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            where.set(cardKey(agent), { agent, lane });
        }
    }
    const parentKeyOf = parentKeys([...where.values()].map((entry) => entry.agent));
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
            const { calling, parentAt } = riderCall(rules, agent, lane, parent);
            if (calling) {
                push(calls, host, agent);
            }
            lifts.set(host, liftWith(lifts.get(host) ?? unlifted(hostEntry), agent, { lane, calling, heard: heardByParent(agent, parentAt) }));
        }
    }
    // Nothing rode anywhere, which is most boards: the lanes go on as they came, so nothing downstream recomputes.
    if (hosts.size === 0) {
        return { lanes, children: EMPTY, hosts: EMPTY, calls: EMPTY, families: EMPTY };
    }
    return { ...dealFamilies(lanes, hosts, lifts), children, hosts, calls };
};

// A family's lift before any rider is read in: where its card's own standing put it. A card already in Active by that
// standing counts its own work in; one lifted there stands for its riders' alone.
const unlifted = (card: { readonly agent: FleetAgent; readonly lane: FleetLane }): Lift => ({
    lane: card.lane,
    calledAt: 0,
    family: card.lane === `active` ? ownReading(card.agent) : undefined,
});

// The lanes less every rider, each family's card in the lane its lift asks for. Attention, once a card was lifted into
// it, is put back in its own order with the lifted card read by its children's newest call; Active, once any family
// stands in it, by how each card reads there (its family's reading, else its own).
const dealFamilies = (
    lanes: Lanes,
    hosts: ReadonlyMap<string, FleetAgent>,
    lifts: ReadonlyMap<string, Lift>,
) => {
    const cards = noLanes();
    const called = new Map<FleetAgent, number>();
    const families = new Map<string, ActiveReading>();
    for (const lane of LANES) {
        for (const agent of lanes[lane].filter((card) => !hosts.has(cardKey(card)))) {
            const lift = lifts.get(cardKey(agent));
            const dealt = lift?.lane ?? lane;
            cards[dealt].push(agent);
            if (dealt === `attention` && lane !== `attention`) {
                called.set(agent, lift?.calledAt ?? agent.updatedAt);
            }
            if (dealt === `active` && lift?.family !== undefined) {
                families.set(cardKey(agent), lift.family);
            }
        }
    }
    if (called.size > 0) {
        cards.attention = ordered(cards.attention, attentionLaneOrder, (card) => ({ ...card, updatedAt: called.get(card) ?? card.updatedAt }));
    }
    if (families.size > 0) {
        cards.active = [...cards.active].sort(activeOrderBy((card) => families.get(cardKey(card)) ?? ownReading(card)));
    }
    return { lanes: cards, families };
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
    // A family can change phase with every card where it was: a child running into a spent allowance moves its parent
    // from Working to Up next without a card moving lane or tray.
    const families = sameReadings(previous.families, next.families) ? previous.families : next.families;
    // The same cards in every lane and tray means the same card under each child, so the hosts are the last answer's too.
    if (lanesStill && children === previous.children && calls === previous.calls && families === previous.families) {
        return previous;
    }
    return { lanes: lanesStill ? previous.lanes : kept, children, hosts: next.hosts, calls, families };
};

const sameReadings = (left: ReadonlyMap<string, ActiveReading>, right: ReadonlyMap<string, ActiveReading>): boolean =>
    left.size === right.size &&
    [...right].every(([key, reading]) => {
        const before = left.get(key);
        return before !== undefined && before.phase === reading.phase && before.startedAt === reading.startedAt && before.goesAt === reading.goesAt;
    });

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
    // Every working child of either kind, the newest started first as Active orders its cards; or while a filter is on,
    // every child it matched.
    readonly lead: readonly TrayChild[];
    // Children stopped on something that is their parent's news first, a row per thing they stopped on.
    readonly groups: readonly TrayGroup[];
    // Settled children of either kind behind the toggle; nothing is folded while a filter is on, since a result set must
    // not hide its own matches, nor when one child settled alone, which is drawn as its own row in `tail`.
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
    // Newest started first, as Active orders its working cards (activePhase.ts) and so the conversations in `lead`.
    const working = subagents.filter(subagentLive).toSorted((a, b) => b.startedAt - a.startedAt);
    const done = subagents.filter((session) => !subagentLive(session)).toSorted((a, b) => settledAt(b) - settledAt(a));
    return {
        lead: weave(lead, working, (a, b) => startOf(a) >= startOf(b)),
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
    // One settled child alone is its own row, as a stop group of one is: the toggle would take the same line to say less,
    // and a press to read a single line.
    if (dealt.settled.length === 1) {
        return { asks, lead: dealt.lead, groups, folded: 0, open: false, tail: dealt.settled };
    }
    const open = state.opened.has(FINISHED_FOLD);
    const tail = open ? dealt.settled : dealt.settled.filter((child) => child.id === state.selected);
    return { asks, lead: dealt.lead, groups, folded: dealt.settled.length, open, tail };
};

// The riders under a card that are its automation's earlier runs rather than agents it started: whatever rides with no
// parent of its own rides as a run of the card's stack (parentKeys).
export const stackedRuns = (children: readonly FleetAgent[]): readonly FleetAgent[] => children.filter((child) => parentOf(child.startedBy) === undefined);

// How many agents a card started, and how many of them are still at work: what the card itself wears (ChildCount), so
// a shut tray still says there is a family under it and whether it is busy. Counted over the same two lists the tray
// deals, unfiltered, so the count never disagrees with the rows the tray draws once it opens.
export interface TrayCount {
    readonly total: number;
    readonly running: number;
}

export const trayCount = (children: readonly FleetAgent[], subagents: readonly SubagentSession[] = NO_SUBAGENTS): TrayCount | undefined => {
    const total = children.length + subagents.length;
    if (total === 0) {
        return undefined;
    }
    // A draft not sent yet (a fresh session being written) is in the tray, and runs nothing.
    const running = children.filter((child) => laneOf(child) === `active` && child.status !== `draft`).length + subagents.filter(subagentLive).length;
    return { total, running };
};

// The conversations a tray draws, top to bottom, for anything that walks the board in drawing order (a Shift+click
// range): an in-process subagent has no chat of its own to open in a pane.
export const trayRows = (tray: Tray | undefined): readonly FleetAgent[] =>
    tray === undefined
        ? []
        : [...tray.asks, ...tray.lead, ...tray.groups.flatMap((group) => group.shown), ...tray.tail].filter(
              (child): child is FleetAgent => !inProcess(child),
          );
