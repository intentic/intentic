// The sweep keeps each sandbox's newest imprints of two kinds apart: a view's own (`sandbox.secrets`) or a page's
// (`route:`, `hub:`, `ext:`), and the many of one kind (`diff:${path}`, a transcript per conversation). Pinned: each kind
// keeps exactly its newest `cap`, so a day of opened files can never push the settings pages out; and only views and
// pages are lent to a sandbox that has not drawn them yet.
import "@intentic/testing/dom";
import { lendsAcross, outgrown } from "../skeletonPersistence";

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
            imprint(`sandbox.roles`, 3),
            imprint(`diff:b.ts`, 6),
            imprint(`diff:c.ts`, 2),
            imprint(`sandbox.areas`, 4),
        ];

        const { kept, dropped } = outgrown(held, 2);

        expect(kept.map((entry) => entry.name)).toEqual([`sandbox.areas`, `sandbox.roles`, `diff:b.ts`, `diff:a.ts`]);
        expect(dropped.map((entry) => entry.name)).toEqual([`sandbox.secrets`, `diff:c.ts`]);
    });

    it(`drops nothing while each kind is within its cap`, () => {
        const { kept, dropped } = outgrown([imprint(`sandbox.secrets`, 1), imprint(`diff:a.ts`, 2)], 1);
        expect(kept.map((entry) => entry.name)).toEqual([`sandbox.secrets`, `diff:a.ts`]);
        expect(dropped).toEqual([]);
    });

    it(`keeps a page with the views, so opened files never push it out`, () => {
        const held = [imprint(`route:/s/a/settings/secrets`, 1), imprint(`file:a.ts`, 2), imprint(`file:b.ts`, 3)];

        const { kept, dropped } = outgrown(held, 1);

        expect(kept.map((entry) => entry.name)).toEqual([`route:/s/a/settings/secrets`, `file:b.ts`]);
        expect(dropped.map((entry) => entry.name)).toEqual([`file:a.ts`]);
    });
});

describe(`lendsAcross`, () => {
    it(`lends a view's look and a page's, never one item's`, () => {
        expect([`sandbox.secrets`, `route:/s/a/settings`, `hub:/s/a/settings/usage#SandboxUsage`, `ext:run/run`].every(lendsAcross)).toBe(true);
        expect([`diff:src/app.ts`, `chat.transcript:c1`, `file:README.md`].some(lendsAcross)).toBe(false);
    });
});
