import type { AttentionReading } from "./homeFacts";
import { clusterOf, type OtherBox } from "./otherSandboxes";

const box = (id: string, role = `owner`): OtherBox => ({ id, name: id.toUpperCase(), role });
const none = new Map<string, AttentionReading>();

describe(`clusterOf`, () => {
    it(`leaves out the sandbox the shell is inside`, () => {
        expect(clusterOf([box(`a`), box(`b`)], `a`, none).slots.map((slot) => slot.id)).toEqual([`b`]);
    });

    it(`is empty when the active sandbox is the only one`, () => {
        expect(clusterOf([box(`a`)], `a`, none)).toEqual({ slots: [], more: 0, names: [], needing: 0 });
    });

    it(`draws three circles when there are exactly three others`, () => {
        const cluster = clusterOf([box(`a`), box(`b`), box(`c`), box(`d`)], `a`, none);
        expect({ ids: cluster.slots.map((slot) => slot.id), more: cluster.more }).toEqual({ ids: [`b`, `c`, `d`], more: 0 });
    });

    it(`folds the rest into the third circle past three`, () => {
        const cluster = clusterOf([box(`a`), box(`b`), box(`c`), box(`d`), box(`e`)], `a`, none);
        expect({ ids: cluster.slots.map((slot) => slot.id), more: cluster.more }).toEqual({ ids: [`b`, `c`], more: 2 });
    });

    it(`keeps Home's order: owned sandboxes before shared ones`, () => {
        expect(clusterOf([box(`m`, `member`), box(`o`)], undefined, none).slots.map((slot) => slot.id)).toEqual([`o`, `m`]);
    });

    it(`moves a sandbox that needs the reader ahead, so the overflow never hides it`, () => {
        const readings = new Map<string, AttentionReading>([[`e`, { needsYou: 2, unreachable: false }]]);
        const cluster = clusterOf([box(`b`), box(`c`), box(`d`), box(`e`)], undefined, readings);
        expect({ ids: cluster.slots.map((slot) => slot.id), more: cluster.more, needing: cluster.needing }).toEqual({
            ids: [`e`, `b`],
            more: 2,
            needing: 1,
        });
    });

    it(`marks a box whose last read went unanswered`, () => {
        const readings = new Map<string, AttentionReading>([[`b`, { needsYou: undefined, unreachable: true }]]);
        expect(clusterOf([box(`b`)], undefined, readings).slots[0]).toMatchObject({ unreachable: true, needsYou: 0 });
    });

    it(`names every other box, the folded ones too`, () => {
        expect(clusterOf([box(`a`), box(`b`), box(`c`), box(`d`), box(`e`)], `a`, none).names).toEqual([`B`, `C`, `D`, `E`]);
    });
});
