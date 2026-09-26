import { NO_ATTENTION } from "../../fleet/agentStatus";
import { type FleetAgent, laneGroups } from "../../fleet/useAgents-fleet";
import { cardKey, foldChildren, standsAlone, steadyFold, type TrayState, trayOf, trayRows } from "./childFold";

// Pins which children ride under their parent's card and which keep a card of their own: a child asking something of
// the reader never rides, a child never rides in a lane quieter than its own, and a grandchild rides with its parent.
// Then what a tray draws: working children always, settled ones behind the fold, a filter's matches unfolded.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const child = (id: string, parent: string, over: Partial<FleetAgent> = {}): FleetAgent => card(id, { startedBy: `agent:${parent}`, ...over });
const working = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => card(id, { status: `running`, startedAt: 1_000, ...over });
const ids = (agents: readonly FleetAgent[] | undefined): string[] => (agents ?? []).map((agent) => agent.id);
const folded = (...fleet: FleetAgent[]) => foldChildren(laneGroups(fleet));

describe(`which children ride under their parent`, () => {
    it(`takes a working child and a settled one off the board and hangs them under the card that started them`, () => {
        const fold = folded(working(`p`), working(`c1`, { startedBy: `agent:p` }), child(`c2`, `p`));
        expect(ids(fold.lanes.active)).toEqual([`p`]);
        expect(ids(fold.lanes.finished)).toEqual([]);
        expect(ids(fold.children.get(`p`))).toEqual([`c1`, `c2`]);
        expect(fold.hosts.get(`c2`)?.id).toBe(`p`);
    });

    it(`draws the working ones first, as Active orders them, then the settled ones newest first`, () => {
        const fold = folded(
            working(`p`),
            child(`old`, `p`, { updatedAt: 2_000 }),
            working(`late`, { startedBy: `agent:p`, startedAt: 9_000 }),
            child(`new`, `p`, { updatedAt: 8_000 }),
            working(`early`, { startedBy: `agent:p`, startedAt: 3_000 }),
        );
        expect(ids(fold.children.get(`p`))).toEqual([`early`, `late`, `new`, `old`]);
    });

    it(`keeps a card for a child that asks something of the reader, even under a parent that asks too`, () => {
        const question = { ...NO_ATTENTION, question: true };
        const fold = folded(
            card(`p`, { status: `awaiting`, attention: question }),
            child(`asks`, `p`, { status: `awaiting`, attention: question }),
            child(`ready`, `p`, { status: `ready` }),
            child(`landing`, `p`, { status: `landing` }),
            child(`gone`, `p`, { landedPresence: { landed: 3, present: 1 } }),
            child(`words`, `p`, { unsent: true }),
            child(`quiet`, `p`),
        );
        expect(ids(fold.lanes.attention).toSorted()).toEqual([`asks`, `p`]);
        expect(ids(fold.lanes.finished).toSorted()).toEqual([`gone`, `landing`, `ready`, `words`]);
        expect(ids(fold.children.get(`p`))).toEqual([`quiet`]);
    });

    it(`never hangs a working child under a finished parent, where the ledger and its window would bury it`, () => {
        const fold = folded(card(`p`), working(`busy`, { startedBy: `agent:p` }), child(`done`, `p`));
        expect(ids(fold.lanes.active)).toEqual([`busy`]);
        expect(ids(fold.children.get(`p`))).toEqual([`done`]);
    });

    it(`leaves a child standing when its parent is not on the board`, () => {
        const fold = folded(child(`orphan`, `archived-parent`));
        expect(ids(fold.lanes.finished)).toEqual([`orphan`]);
        expect(fold.children.size).toBe(0);
    });

    it(`hangs a grandchild under the card its parent rides under`, () => {
        const fold = folded(working(`root`), working(`mid`, { startedBy: `agent:root` }), child(`leaf`, `mid`));
        expect(ids(fold.lanes.active)).toEqual([`root`]);
        expect(ids(fold.children.get(`root`))).toEqual([`mid`, `leaf`]);
        expect(fold.hosts.get(`leaf`)?.id).toBe(`root`);
    });

    it(`hangs a grandchild under its parent's own card when its parent stands apart`, () => {
        const permission = { ...NO_ATTENTION, permission: true };
        const fold = folded(working(`root`), child(`mid`, `root`, { status: `awaiting`, attention: permission }), child(`leaf`, `mid`));
        expect(ids(fold.lanes.attention)).toEqual([`mid`]);
        expect(ids(fold.children.get(`mid`))).toEqual([`leaf`]);
        expect(fold.children.get(`root`)).toBeUndefined();
    });

    it(`ends the walk on a record naming its own descendant as its parent`, () => {
        const fold = folded(child(`a`, `b`), child(`b`, `a`));
        expect(ids([...fold.lanes.finished, ...fold.lanes.active])).toHaveLength(1);
        expect(fold.hosts.size).toBe(1);
    });

    it(`reads a parent's id in its child's own box, so two boxes' same-named conversations never cross`, () => {
        const fold = folded(working(`p`, { sandboxId: `box-a` }), child(`c`, `p`, { sandboxId: `box-b` }), child(`d`, `p`, { sandboxId: `box-a` }));
        expect(ids(fold.lanes.finished)).toEqual([`c`]);
        expect(ids(fold.children.get(cardKey({ id: `p`, sandboxId: `box-a` })))).toEqual([`d`]);
    });

    it(`hands a board with no children back as it came, so nothing downstream recomputes`, () => {
        const lanes = laneGroups([working(`a`), card(`b`)]);
        expect(foldChildren(lanes).lanes).toBe(lanes);
    });

    it(`hangs every filed child under its filed parent in the archive, where nothing asks for a press`, () => {
        const filed = [card(`p`), child(`ready`, `p`, { status: `ready` }), child(`words`, `p`, { unsent: true })];
        const fold = foldChildren({ attention: [], active: [], finished: filed }, () => false);
        expect(ids(fold.lanes.finished)).toEqual([`p`]);
        expect(ids(fold.children.get(`p`))).toEqual([`ready`, `words`]);
    });

    it(`says a draft never rides: it has no record to ride with`, () => {
        expect(standsAlone(child(`draft`, `p`, { status: `draft` }))).toBe(true);
        expect(standsAlone(child(`quiet`, `p`))).toBe(false);
    });
});

describe(`a steady fold`, () => {
    it(`keeps the last answer's lists wherever the same cards stand in the same order`, () => {
        const parent = working(`p`);
        const kids = [working(`c1`, { startedBy: `agent:p` }), child(`c2`, `p`)];
        const first = folded(parent, ...kids, card(`other`));
        const next = steadyFold(first, folded(parent, ...kids, card(`other`, { updatedAt: 5_000 })));
        expect(next.children.get(`p`)).toBe(first.children.get(`p`));
        expect(next.lanes.active).toBe(first.lanes.active);
        expect(next.lanes.finished).not.toBe(first.lanes.finished);
    });

    it(`hands back the last answer whole when nothing moved`, () => {
        const fleet = [working(`p`), child(`c1`, `p`), card(`other`)];
        const first = folded(...fleet);
        expect(steadyFold(first, folded(...fleet))).toBe(first);
    });

    it(`hands a changed tray a new list`, () => {
        const first = folded(working(`p`), child(`c1`, `p`));
        const next = steadyFold(first, folded(working(`p`), child(`c1`, `p`), child(`c2`, `p`)));
        expect(ids(next.children.get(`p`))).toEqual([`c1`, `c2`]);
        expect(next.children.get(`p`)).not.toBe(first.children.get(`p`));
    });
});

describe(`what a tray draws`, () => {
    const [w1, w2, s1, s2] = [working(`w1`), working(`w2`), card(`s1`, { updatedAt: 9_000 }), card(`s2`, { updatedAt: 8_000 })];
    const brood = [w1, w2, s1, s2];
    const at = (over: Partial<TrayState> = {}): TrayState => ({ open: false, filtering: false, matches: () => true, selected: undefined, ...over });

    it(`shows every working child and folds the settled ones behind a count`, () => {
        expect(trayOf(brood, at())).toEqual({ lead: [w1, w2], folded: 2, open: false, tail: [] });
    });

    it(`unfolds the settled ones under the toggle`, () => {
        const tray = trayOf(brood, at({ open: true }));
        expect(ids(tray?.tail)).toEqual([`s1`, `s2`]);
        expect(ids(trayRows(tray))).toEqual([`w1`, `w2`, `s1`, `s2`]);
    });

    it(`keeps the settled child wearing the ring in sight with the fold shut`, () => {
        const tray = trayOf(brood, at({ selected: `s2` }));
        expect(tray?.folded).toBe(2);
        expect(ids(tray?.tail)).toEqual([`s2`]);
    });

    it(`lists only a filter's matches, and folds none of them away`, () => {
        const tray = trayOf(brood, at({ filtering: true, matches: (agent) => agent.id === `s2` || agent.id === `w1` }));
        expect(tray).toEqual({ lead: [w1, s2], folded: 0, open: false, tail: [] });
    });

    it(`draws nothing for a card with no children, or none the filter kept`, () => {
        expect(trayOf([], at())).toBeUndefined();
        expect(trayOf(undefined, at())).toBeUndefined();
        expect(trayOf(brood, at({ filtering: true, matches: () => false }))).toBeUndefined();
        expect(trayRows(undefined)).toEqual([]);
    });
});
