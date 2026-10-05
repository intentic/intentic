// The sweep keeps each sandbox's newest imprints of two kinds apart: a view's own (`sandbox.secrets`) and the many of
// one kind (`diff:${path}`, a transcript per conversation). Pinned: each kind keeps exactly its newest `cap`, so a day
// of opened files can never push the settings pages out.
import "@intentic/testing/dom";
import { outgrown } from "../skeletonPersistence";

interface Taken {
    readonly name: string;
    readonly at: number;
}

const imprint = (name: string, at: number): Taken => ({ name, at });

describe(`outgrown`, () => {
    it(`keeps the newest of each kind up to the cap and drops the rest, oldest first`, () => {
        const held = [
            imprint(`sandbox.secrets`, 1),
            imprint(`diff:a.ts`, 5),
            imprint(`sandbox.personas`, 3),
            imprint(`diff:b.ts`, 6),
            imprint(`diff:c.ts`, 2),
            imprint(`sandbox.areas`, 4),
        ];

        const { kept, dropped } = outgrown(held, 2);

        expect(kept.map((entry) => entry.name)).toEqual([`sandbox.areas`, `sandbox.personas`, `diff:b.ts`, `diff:a.ts`]);
        expect(dropped.map((entry) => entry.name)).toEqual([`sandbox.secrets`, `diff:c.ts`]);
    });

    it(`drops nothing while each kind is within its cap`, () => {
        const { kept, dropped } = outgrown([imprint(`sandbox.secrets`, 1), imprint(`diff:a.ts`, 2)], 1);
        expect(kept.map((entry) => entry.name)).toEqual([`sandbox.secrets`, `diff:a.ts`]);
        expect(dropped).toEqual([]);
    });
});
