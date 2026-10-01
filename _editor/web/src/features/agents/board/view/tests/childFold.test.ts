import type { SubagentSession } from "@intentic/sandbox-contract";
import { NO_ATTENTION } from "../../../fleet/agentStatus";
import { type FleetAgent, laneGroups } from "../../../fleet/useAgents-fleet";
import {
    ARCHIVE_RULES,
    cardKey,
    FINISHED_FOLD,
    foldChildren,
    standsAlone,
    steadyFold,
    stopOf,
    trayCount,
    type TrayState,
    trayOf,
    trayRows,
} from "../childFold";

// Pins which children ride under their parent's card and which keep a card of their own: every child rides while its
// parent is on the board, save one owing a press a row cannot carry; a child calling the reader moves its family's card
// to Attention instead of standing there itself; a grandchild rides with its parent. Then what a tray draws: asks and
// working children always, stopped ones one row per thing they stopped on, settled ones behind the fold, a filter's
// matches unfolded; and the subagents its runtime ran in-process dealt into those same rows.

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
const limited = (id: string, parent: string, over: Partial<FleetAgent> = {}): FleetAgent =>
    child(id, parent, { status: `error`, failureCode: `rate_limit`, provider: `codex`, ...over });
const permission = { ...NO_ATTENTION, permission: true };
const ids = (agents: readonly { readonly id: string }[] | undefined): string[] => (agents ?? []).map((agent) => agent.id);
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

    it(`keeps Attention quiet for children stopped under a parent still supervising them: they are its news`, () => {
        const fold = folded(
            working(`p`),
            ...Array.from({ length: 15 }, (_unused, at) => limited(`c${at}`, `p`)),
            child(`broke`, `p`, { status: `error` }),
            child(`asked`, `p`, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } }),
        );
        expect(fold.lanes.attention).toEqual([]);
        expect(ids(fold.lanes.active)).toEqual([`p`]);
        expect(fold.children.get(`p`)).toHaveLength(17);
        expect(fold.calls.get(`p`)).toBeUndefined();
    });

    it(`moves the family's card to Attention for a child asking what only the reader can give, however busy the parent`, () => {
        const fold = folded(
            working(`p`),
            child(`keys`, `p`, { status: `awaiting`, attention: permission }),
            working(`port`, { startedBy: `agent:p` }),
        );
        expect(ids(fold.lanes.attention)).toEqual([`p`]);
        expect(fold.lanes.active).toEqual([]);
        expect(ids(fold.children.get(`p`))).toEqual([`keys`, `port`]);
        expect(ids(fold.calls.get(`p`))).toEqual([`keys`]);
    });

    it(`hands a stopped child to the reader through its parent's card once the parent stops supervising`, () => {
        const fold = folded(card(`p`), limited(`a`, `p`), child(`b`, `p`, { status: `stopped` }), child(`done`, `p`));
        expect(ids(fold.lanes.attention)).toEqual([`p`]);
        expect(ids(fold.calls.get(`p`)).toSorted()).toEqual([`a`, `b`]);
        expect(ids(fold.children.get(`p`))).toContain(`done`);
    });

    it(`keeps a card only for a child owing a press a row cannot carry, and lets one asking the reader ride`, () => {
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
        expect(ids(fold.lanes.attention)).toEqual([`p`]);
        expect(ids(fold.lanes.finished).toSorted()).toEqual([`gone`, `landing`, `ready`, `words`]);
        expect(ids(fold.children.get(`p`))).toEqual([`asks`, `quiet`]);
        expect(ids(fold.calls.get(`p`))).toEqual([`asks`]);
    });

    it(`lifts a finished parent into Active while a child still works, rather than burying the work in the ledger`, () => {
        const fold = folded(card(`p`), working(`busy`, { startedBy: `agent:p` }), child(`done`, `p`));
        expect(ids(fold.lanes.active)).toEqual([`p`]);
        expect(fold.lanes.finished).toEqual([]);
        expect(ids(fold.children.get(`p`))).toEqual([`busy`, `done`]);
    });

    it(`puts a lifted card where its lane's own order would: Attention by the newest call, Active by the earliest work`, () => {
        const calls = folded(
            card(`other`, { status: `error`, updatedAt: 5_000 }),
            card(`late`),
            child(`late-ask`, `late`, { status: `awaiting`, attention: permission, updatedAt: 9_000 }),
            card(`early`),
            child(`early-ask`, `early`, { status: `awaiting`, attention: permission, updatedAt: 2_000 }),
        );
        expect(ids(calls.lanes.attention)).toEqual([`late`, `other`, `early`]);
        const work = folded(
            working(`mid`, { startedAt: 5_000 }),
            card(`p`, { startedAt: 9_000 }),
            working(`kid`, { startedBy: `agent:p`, startedAt: 2_000 }),
        );
        expect(ids(work.lanes.active)).toEqual([`p`, `mid`]);
    });

    it(`leaves a child standing when its parent is not on the board`, () => {
        const fold = folded(child(`orphan`, `archived-parent`));
        expect(ids(fold.lanes.finished)).toEqual([`orphan`]);
        expect(fold.children.size).toBe(0);
    });

    it(`hangs a grandchild under the card its parent rides under, and lets it call the reader through that card`, () => {
        const fold = folded(
            working(`root`),
            working(`mid`, { startedBy: `agent:root` }),
            child(`leaf`, `mid`, { status: `awaiting`, attention: permission }),
        );
        expect(ids(fold.lanes.attention)).toEqual([`root`]);
        expect(ids(fold.children.get(`root`))).toEqual([`leaf`, `mid`]);
        expect(fold.hosts.get(`leaf`)?.id).toBe(`root`);
        expect(ids(fold.calls.get(`root`))).toEqual([`leaf`]);
    });

    it(`hangs a grandchild under its parent's own card when its parent stands apart`, () => {
        const fold = folded(working(`root`), child(`mid`, `root`, { status: `ready` }), child(`leaf`, `mid`));
        expect(ids(fold.lanes.finished)).toEqual([`mid`]);
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

    it(`hangs every filed child under its filed parent in the archive, where nothing asks and nothing moves`, () => {
        const filed = [card(`p`), child(`ready`, `p`, { status: `ready` }), child(`words`, `p`, { unsent: true }), limited(`spent`, `p`)];
        const fold = foldChildren({ attention: [], active: [], finished: filed }, ARCHIVE_RULES);
        expect(ids(fold.lanes.finished)).toEqual([`p`]);
        expect(ids(fold.children.get(`p`))).toEqual([`ready`, `words`, `spent`]);
        expect(fold.calls.size).toBe(0);
    });

    it(`says a draft never rides, and a child asking the reader does`, () => {
        expect(standsAlone(child(`draft`, `p`, { status: `draft` }))).toBe(true);
        expect(standsAlone(child(`quiet`, `p`))).toBe(false);
        expect(standsAlone(child(`asks`, `p`, { status: `awaiting`, attention: permission }))).toBe(false);
    });

    // Landed work taken back out stands alone for its Land again, unless an agent (its orchestrator) took it out on
    // purpose, which offers no press to stand for.
    it(`keeps a card of its own for landed work a person took out, not for work an agent took out`, () => {
        expect(standsAlone(child(`discarded`, `p`, { landedPresence: { landed: 3, present: 0 } }))).toBe(true);
        expect(standsAlone(child(`tidied`, `p`, { landedPresence: { landed: 3, present: 0, removedBy: { kind: `agent`, id: `p` } } }))).toBe(false);
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
        const fleet = [working(`p`), child(`c1`, `p`), card(`other`), child(`asks`, `p`, { status: `awaiting`, attention: permission })];
        const first = folded(...fleet);
        expect(steadyFold(first, folded(...fleet))).toBe(first);
    });

    it(`hands a changed tray a new list, and keeps the calls it did not change`, () => {
        const asks = child(`asks`, `p`, { status: `awaiting`, attention: permission });
        const first = folded(working(`p`), child(`c1`, `p`), asks);
        const next = steadyFold(first, folded(working(`p`), child(`c1`, `p`), child(`c2`, `p`), asks));
        expect(ids(next.children.get(`p`))).toEqual([`asks`, `c1`, `c2`]);
        expect(next.children.get(`p`)).not.toBe(first.children.get(`p`));
        expect(next.calls).toBe(first.calls);
    });
});

describe(`what a tray draws`, () => {
    const [w1, w2, s1, s2] = [working(`w1`), working(`w2`), card(`s1`, { updatedAt: 9_000 }), card(`s2`, { updatedAt: 8_000 })];
    const brood = [w1, w2, s1, s2];
    const at = (over: Partial<TrayState> = {}): TrayState => ({
        opened: new Set(),
        asking: true,
        filtering: false,
        matches: () => true,
        matchesSubagent: () => true,
        selected: undefined,
        ...over,
    });

    it(`shows every working child and folds the settled ones behind a count`, () => {
        expect(trayOf(brood, at())).toEqual({ asks: [], lead: [w1, w2], groups: [], folded: 2, open: false, tail: [] });
    });

    it(`unfolds the settled ones under the toggle`, () => {
        const tray = trayOf(brood, at({ opened: new Set([FINISHED_FOLD]) }));
        expect(ids(tray?.tail)).toEqual([`s1`, `s2`]);
        expect(ids(trayRows(tray))).toEqual([`w1`, `w2`, `s1`, `s2`]);
    });

    it(`keeps the settled child wearing the ring in sight with the fold shut`, () => {
        const tray = trayOf(brood, at({ selected: `s2` }));
        expect(tray?.folded).toBe(2);
        expect(ids(tray?.tail)).toEqual([`s2`]);
    });

    it(`leads with a child asking what only the reader can give, and never asks from the archive`, () => {
        const asks = child(`asks`, `p`, { status: `awaiting`, attention: permission });
        expect(ids(trayOf([w1, asks], at())?.asks)).toEqual([`asks`]);
        expect(trayOf([w1, asks], at({ asking: false }))?.asks).toEqual([]);
    });

    it(`draws children stopped on one thing as one row, a spent allowance by its provider, shut until opened`, () => {
        const spent = Array.from({ length: 3 }, (_unused, index) => limited(`c${index}`, `p`));
        const other = limited(`k`, `p`, { provider: `kimi` });
        const broke = [child(`e1`, `p`, { status: `error` }), child(`e2`, `p`, { status: `error` })];
        const tray = trayOf([w1, ...broke, ...spent, other, s1], at());
        expect(tray?.groups.map((group) => [group.key, ids(group.members), ids(group.shown)])).toEqual([
            [`limit:codex`, [`c0`, `c1`, `c2`], []],
            [`limit:kimi`, [`k`], [`k`]],
            [`error`, [`e1`, `e2`], []],
        ]);
        expect(ids(trayRows(tray))).toEqual([`w1`, `k`]);
        const opened = trayOf([w1, ...broke, ...spent, other, s1], at({ opened: new Set([`error`]), selected: `c1` }));
        expect(ids(trayRows(opened))).toEqual([`w1`, `c1`, `k`, `e1`, `e2`]);
    });

    it(`names what a child stopped on`, () => {
        expect(stopOf(limited(`a`, `p`))).toBe(`limit:codex`);
        expect(stopOf(child(`b`, `p`, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } }))).toBe(`question`);
        expect(stopOf(child(`c`, `p`, { status: `conflict`, attention: { ...NO_ATTENTION, conflict: true } }))).toBe(`conflict`);
        expect(stopOf(child(`d`, `p`, { status: `stopped` }))).toBe(`stopped`);
    });

    it(`lists only a filter's matches, and folds none of them away`, () => {
        const tray = trayOf(brood, at({ filtering: true, matches: (agent) => agent.id === `s2` || agent.id === `w1` }));
        expect(tray).toEqual({ asks: [], lead: [w1, s2], groups: [], folded: 0, open: false, tail: [] });
    });

    it(`draws nothing for a card with no children, or none the filter kept`, () => {
        expect(trayOf([], at())).toBeUndefined();
        expect(trayOf(undefined, at())).toBeUndefined();
        expect(trayOf(brood, at({ filtering: true, matches: () => false }))).toBeUndefined();
        expect(trayRows(undefined)).toEqual([]);
    });

    // A subagent the card's runtime ran in-process has no conversation, so the roster hands it to the tray, which deals it
    // into the same rows by the same clocks: the working ones among the working as Active orders its cards, the settled
    // ones among the settled as Finished does. It never asks, and a range never walks it, having no chat of its own.
    describe(`with the subagents its runtime ran in-process`, () => {
        const session = (id: string, over: Partial<SubagentSession> = {}): SubagentSession => ({
            id,
            kind: `subagent`,
            conversationId: `p`,
            status: `running`,
            startedAt: 1_000,
            activityAt: 1_000,
            ...over,
        });
        const early = session(`early`, { startedAt: 500 });
        const late = session(`late`, { startedAt: 2_000 });
        const newest = session(`newest`, { status: `completed`, endedAt: 9_500, activityAt: 9_500 });
        const oldest = session(`oldest`, { status: `failed`, endedAt: 7_000, activityAt: 7_000 });

        it(`weaves the working ones among the working by when each started, and counts the settled ones in the one fold`, () => {
            const tray = trayOf(brood, at(), [late, newest, early, oldest]);
            expect(ids(tray?.lead)).toEqual([`early`, `w1`, `w2`, `late`]);
            expect([tray?.asks, tray?.groups, tray?.folded]).toEqual([[], [], 4]);
        });

        it(`unfolds the settled ones among the settled, newest first`, () => {
            expect(ids(trayOf(brood, at({ opened: new Set([FINISHED_FOLD]) }), [oldest, newest])?.tail)).toEqual([`newest`, `s1`, `s2`, `oldest`]);
        });

        it(`leaves them out of a range's walk, having no chat to open`, () => {
            const tray = trayOf(brood, at({ opened: new Set([FINISHED_FOLD]) }), [early, newest]);
            expect(ids(trayRows(tray))).toEqual([`w1`, `w2`, `s1`, `s2`]);
        });

        it(`draws a tray for a card whose only children ran in-process`, () => {
            expect(trayOf([], at(), [early])).toEqual({ asks: [], lead: [early], groups: [], folded: 0, open: false, tail: [] });
            expect(trayOf(undefined, at(), [newest])).toEqual({ asks: [], lead: [], groups: [], folded: 1, open: false, tail: [] });
        });

        it(`lists the ones a filter matched beside the conversations it matched`, () => {
            const filtered = at({ filtering: true, matches: (agent) => agent.id === `w1`, matchesSubagent: (found) => found.id === `late` });
            expect(ids(trayOf(brood, filtered, [early, late])?.lead)).toEqual([`w1`, `late`]);
            expect(trayOf([], { ...filtered, matchesSubagent: () => false }, [early, late])).toBeUndefined();
        });
    });
});

// What a card wears while its tray is shut: every agent it started, and how many of them are still at work.
describe(`what a card counts of its family`, () => {
    const subagent = (id: string, status: SubagentSession["status"]): SubagentSession => ({
        id,
        kind: `subagent`,
        conversationId: `p`,
        agentType: `Explore`,
        status,
        startedAt: 1,
        activityAt: 1,
    });

    it(`counts nothing for a card that started nothing`, () => {
        expect(trayCount([], [])).toBeUndefined();
    });

    it(`counts spawned and in-process children together, only the working ones as running`, () => {
        const children = [
            working(`w`, { startedBy: `agent:p` }),
            child(`done`, `p`),
            child(`asked`, `p`, { status: `awaiting`, attention: permission }),
            limited(`spent`, `p`),
        ];
        expect(trayCount(children, [subagent(`s1`, `running`), subagent(`s2`, `completed`)])).toEqual({ total: 6, running: 2 });
    });

    it(`counts a family with none at work as running none`, () => {
        expect(trayCount([child(`done`, `p`)], [subagent(`s`, `completed`)])).toEqual({ total: 2, running: 0 });
    });
});
