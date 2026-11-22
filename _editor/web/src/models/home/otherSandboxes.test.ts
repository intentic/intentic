import type { AttentionReading } from "./homeFacts";
import { clusterOf, MAKING_SLOT_ID, type OtherBox } from "./otherSandboxes";

const box = (id: string, tier = `owner`): OtherBox => ({ id, name: id.toUpperCase(), tier });
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

    it(`keeps the reader's own arrangement`, () => {
        expect(clusterOf([box(`b`), box(`c`), box(`d`)], undefined, none, [`d`, `b`]).slots.map((slot) => slot.id)).toEqual([`d`, `b`, `c`]);
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

    describe(`the sandbox Home is making`, () => {
        it(`is a circle even when the sandbox the shell is inside is the only other one, so the way back to it stands`, () => {
            const cluster = clusterOf([box(`a`)], `a`, none, [], { making: { id: undefined, name: `New`, state: `running` } });
            expect(cluster.slots).toEqual([expect.objectContaining({ id: MAKING_SLOT_ID, name: `New`, making: `running` })]);
            expect(cluster.names).toEqual([`New`]);
        });

        it(`is drawn once, as the sandbox being made, once the list has its row`, () => {
            const cluster = clusterOf([box(`a`), box(`n`)], `a`, none, [], { making: { id: `n`, name: `N`, state: `opening` } });
            expect(cluster.slots.map((slot) => [slot.id, slot.making])).toEqual([[`n`, `opening`]]);
        });

        it(`comes first, so the overflow never folds it away`, () => {
            const cluster = clusterOf([box(`a`), box(`b`), box(`c`), box(`d`)], `a`, none, [], {
                making: { id: `n`, name: `N`, state: `running` },
            });
            expect({ ids: cluster.slots.map((slot) => slot.id), more: cluster.more }).toEqual({ ids: [`n`, `b`], more: 2 });
        });

        it(`counts as needing the reader while it asks something or stopped`, () => {
            expect(clusterOf([], undefined, none, [], { making: { id: `n`, name: `N`, state: `asking` } }).needing).toBe(1);
            expect(clusterOf([], undefined, none, [], { making: { id: `n`, name: `N`, state: `failed` } }).needing).toBe(1);
            expect(clusterOf([], undefined, none, [], { making: { id: `n`, name: `N`, state: `running` } }).needing).toBe(0);
        });

        it(`is not drawn inside itself`, () => {
            expect(clusterOf([box(`n`)], `n`, none, [], { making: { id: `n`, name: `N`, state: `opening` } }).slots).toEqual([]);
        });
    });

    it(`marks a sandbox made while the reader was elsewhere, ahead of the quiet ones`, () => {
        const cluster = clusterOf([box(`b`), box(`c`), box(`d`), box(`e`)], undefined, none, [], { ready: new Set([`e`]) });
        expect(cluster.slots.map((slot) => [slot.id, slot.ready])).toEqual([
            [`e`, true],
            [`b`, false],
        ]);
    });
});
