import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { landStripOf, type LandStripFacts } from "./landStrip";

type Agent = Pick<FleetAgent, `id` | `status` | `archivedAt` | `diff`>;

const agent = (over: Partial<Agent> = {}): Agent => ({
    id: `brave-otter`,
    status: `ready`,
    diff: { files: 4, insertions: 120, deletions: 18 },
    ...over,
});
const facts = (over: Partial<LandStripFacts> = {}): LandStripFacts => ({ canAct: true, streaming: false, elsewhere: false, ...over });

describe(`landStripOf`, () => {
    it(`offers the land for work waiting on its branch, with its diff`, () => {
        expect(landStripOf(agent(), facts())).toEqual({ kind: `ready`, diff: { files: 4, insertions: 120, deletions: 18 } });
    });

    it(`leaves out a diff of renames alone, as the board card does`, () => {
        expect(landStripOf(agent({ diff: { files: 2, insertions: 0, deletions: 0 } }), facts())).toEqual({ kind: `ready`, diff: undefined });
    });

    it(`says a land under way and a refused one`, () => {
        expect(landStripOf(agent({ status: `landing` }), facts())).toEqual({ kind: `landing` });
        expect(landStripOf(agent({ status: `conflict` }), facts())).toEqual({ kind: `conflict` });
    });

    it.each([`running`, `idle`, `landed`, `error`, `awaiting`] as const)(`says nothing for a card that is %s`, (status) => {
        expect(landStripOf(agent({ status }), facts())).toBeUndefined();
    });

    it(`says nothing while a turn streams, to a guest, or for another box's chat`, () => {
        expect(landStripOf(agent(), facts({ streaming: true }))).toBeUndefined();
        expect(landStripOf(agent(), facts({ canAct: false }))).toBeUndefined();
        expect(landStripOf(agent(), facts({ elsewhere: true }))).toBeUndefined();
    });

    it(`says nothing for an archived card, a home conversation, or a chat with no card`, () => {
        expect(landStripOf(agent({ archivedAt: 1 }), facts())).toBeUndefined();
        expect(landStripOf(agent({ id: `home-workspace` }), facts())).toBeUndefined();
        expect(landStripOf(undefined, facts())).toBeUndefined();
    });
});
