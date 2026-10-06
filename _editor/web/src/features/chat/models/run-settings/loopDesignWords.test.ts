import { type LoopDesign, loopDesignLine } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { loopDesignWords } from "./loopDesignWords";

const design = (over: Partial<LoopDesign>): LoopDesign => ({
    id: `polish`,
    name: `Polish`,
    context: `fresh`,
    output: { kind: `claim` },
    checks: [],
    maxIterations: 5,
    stallLimit: 2,
    ...over,
});

// One design per way the line can end, and both ceilings.
const designs: readonly LoopDesign[] = [
    design({ checks: [{ kind: `command`, command: `pnpm test` }], maxSpendUsd: 3 }),
    design({ checks: [{ kind: `judge`, rubric: `Is it done?` }], maxIterations: 1 }),
    design({ output: { kind: `none` } }),
    design({}),
];

test(`in English it reads exactly as the contract's line`, () => {
    expect(designs.map(loopDesignWords)).toEqual(designs.map(loopDesignLine));
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`what ends it and how far it may go read in Polish, a command and a dollar figure as they are`, () => {
        expect(designs.map(loopDesignWords)).toEqual([
            `pnpm test · 5 iteracji · $3`,
            `recenzent się zgadza · 1 iteracja`,
            `nic tego nie sprawdza · 5 iteracji`,
            `agent tak uzna · 5 iteracji`,
        ]);
    });
});
