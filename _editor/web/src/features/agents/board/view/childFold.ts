import { type FleetLane, laneOf, unregistered } from "../../fleet/agentStatus";
import { type FleetAgent, finishedNeedsReland } from "../../fleet/useAgents-fleet";
import { parentOf } from "../ownership";

// CHILDREN RIDE UNDER THEIR PARENT. A conversation another one spawned (`startedBy: agent:<id>`) is drawn as a slim row
// under the card of the conversation that started it rather than as a card of its own: an orchestrator that delegates
// to thirty children otherwise fills the board with thirty cards telling one story, and the story's own card is lost
// among them. Pure over the lanes, as withoutSteps is, so every count, window and range the board reads is taken from
// the cards it actually draws.

// Most urgent first. A row is drawn in its host's lane, so a child rides only as high as its own lane or higher, never
// lower: a working child under a finished parent would sit in the ledger where nobody looks for work in flight, and
// Finished's window could fold it out of sight altogether.
const URGENCY = { attention: 0, active: 1, finished: 2 } as const satisfies Record<FleetLane, number>;

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

// A child that asks something of the reader keeps its card, since the card's chip and press are how it asks: anything
// in Attention (a lane that must list everything waiting on the reader), a land owed or under way, landed work the
// workspace no longer holds, words left in its composer. A row only ever reports.
export const standsAlone = (agent: FleetAgent): boolean =>
    unregistered(agent.status) ||
    laneOf(agent) === `attention` ||
    agent.status === `ready` ||
    agent.status === `landing` ||
    finishedNeedsReland(agent) ||
    agent.unsent;

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
    // The lanes less every child riding under a card: what the board draws as cards.
    readonly lanes: Lanes;
    // What rides under each card, by its cardKey, in drawing order: working children as Active orders them, then
    // settled ones as Finished does, newest first. A grandchild rides under the same card as its parent does.
    readonly children: ReadonlyMap<string, readonly FleetAgent[]>;
    // The card each riding child is drawn under, by the child's cardKey.
    readonly hosts: ReadonlyMap<string, FleetAgent>;
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

const noLanes = (): Lanes => ({ attention: [], active: [], finished: [] });

// `alone` says which children keep a card wherever their parent is: the board's own rule, or none at all for the
// archive, where every press is withheld until a card is restored and so nothing is asking.
export const foldChildren = (lanes: Lanes, alone: (agent: FleetAgent) => boolean = standsAlone): ChildFold => {
    const where = new Map<string, { readonly agent: FleetAgent; readonly lane: FleetLane }>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            where.set(cardKey(agent), { agent, lane });
        }
    }
    // The card a conversation rides under, `undefined` for one that is a card itself. Memoised, and walked with the
    // path it came by, so a record naming its own descendant as its parent ends the walk instead of looping.
    const hostKeys = new Map<string, string | undefined>();
    const hostOf = (key: string, path: ReadonlySet<string>): string | undefined => {
        if (hostKeys.has(key)) {
            return hostKeys.get(key);
        }
        const self = where.get(key);
        const parentId = self === undefined ? undefined : parentOf(self.agent.startedBy);
        const parentKey = parentId === undefined || self === undefined ? undefined : keyOf(parentId, self.agent.sandboxId);
        let host: string | undefined;
        if (self !== undefined && parentKey !== undefined && where.has(parentKey) && !path.has(parentKey) && !alone(self.agent)) {
            const above = hostOf(parentKey, new Set([...path, key])) ?? parentKey;
            const aboveLane = where.get(above)?.lane;
            host = aboveLane !== undefined && URGENCY[aboveLane] <= URGENCY[self.lane] ? above : undefined;
        }
        hostKeys.set(key, host);
        return host;
    };
    const cards = noLanes();
    const children = new Map<string, FleetAgent[]>();
    const hosts = new Map<string, FleetAgent>();
    for (const lane of LANES) {
        for (const agent of lanes[lane]) {
            const key = cardKey(agent);
            const host = hostOf(key, new Set());
            const hostCard = host === undefined ? undefined : where.get(host)?.agent;
            if (host === undefined || hostCard === undefined) {
                cards[lane].push(agent);
                continue;
            }
            const brood = children.get(host);
            if (brood === undefined) {
                children.set(host, [agent]);
            } else {
                brood.push(agent);
            }
            hosts.set(key, hostCard);
        }
    }
    // Nothing rode anywhere, which is most boards: the lanes go on as they came, so nothing downstream recomputes.
    if (hosts.size === 0) {
        return { lanes, children: EMPTY, hosts: EMPTY };
    }
    return { lanes: cards, children, hosts };
};

const sameMembers = <T>(left: readonly T[] | undefined, right: readonly T[]): boolean =>
    left !== undefined && left.length === right.length && left.every((entry, at) => entry === right[at]);

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
    const children = new Map<string, readonly FleetAgent[]>();
    for (const [key, brood] of next.children) {
        const before = previous.children.get(key);
        children.set(key, before !== undefined && sameMembers(before, brood) ? before : brood);
    }
    const childrenStill =
        children.size === previous.children.size && [...children].every(([key, brood]) => previous.children.get(key) === brood);
    // The same cards in every lane and tray means the same card under each child, so the hosts are the last answer's too.
    if (lanesStill && childrenStill) {
        return previous;
    }
    return { lanes: lanesStill ? previous.lanes : kept, children: childrenStill ? previous.children : children, hosts: next.hosts };
};

// What a card's tray draws: rows above the fold, how many settled children the fold holds, and the rows under it.
export interface Tray {
    // Every working child, or while a filter is on, every child it matched.
    readonly lead: readonly FleetAgent[];
    // Settled children behind the toggle; nothing is folded while a filter is on, since a result set must not hide its
    // own matches.
    readonly folded: number;
    readonly open: boolean;
    // Drawn under the toggle: all of the settled children while it is open, else only the one wearing the ring, which
    // stays in sight wherever it is, as the Finished window keeps its selection (windowFinished).
    readonly tail: readonly FleetAgent[];
}

export interface TrayState {
    readonly open: boolean;
    readonly filtering: boolean;
    readonly matches: (agent: FleetAgent) => boolean;
    readonly selected: string | undefined;
}

// A tray is only drawn with something in it: a card whose children the filter all passed over has none.
export const trayOf = (children: readonly FleetAgent[] | undefined, state: TrayState): Tray | undefined => {
    if (children === undefined || children.length === 0) {
        return undefined;
    }
    if (state.filtering) {
        const lead = children.filter(state.matches);
        return lead.length === 0 ? undefined : { lead, folded: 0, open: false, tail: [] };
    }
    const lead = children.filter((child) => laneOf(child) !== `finished`);
    const settled = children.filter((child) => laneOf(child) === `finished`);
    const tail = state.open ? settled : settled.filter((child) => child.id === state.selected);
    return { lead, folded: settled.length, open: state.open, tail };
};

// The rows a tray draws, top to bottom, for anything that walks the board in drawing order (a Shift+click range).
export const trayRows = (tray: Tray | undefined): readonly FleetAgent[] => (tray === undefined ? [] : [...tray.lead, ...tray.tail]);
