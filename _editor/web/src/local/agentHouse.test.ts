import { blocksStacked, HOUSE_STAGES, houseStageOf, reached } from "./agentHouse";

// The house on a folder's build card is drawn by what the setup has really reached: each phase builds one part, and a
// build that is ready stands finished whatever phase it ended on.

it(`builds one part per phase the setup reaches, in the order the setup runs them`, () => {
    const phases = [
        `fetching-ic`,
        `checking-docker`,
        `installing-docker`,
        `preflight`,
        `claiming-code`,
        `pulling-image`,
        `starting-sandbox`,
        `waiting-health`,
        `verifying`,
        `desktop-sync`,
        `connecting-machine`,
    ];
    const stages = phases.map((phase) => houseStageOf({ state: `building`, phase }));
    expect(stages).toEqual([`plan`, `plan`, `plan`, `plan`, `plan`, `ground`, `walls`, `roof`, `lit`, `moving`, `home`]);
    // Never backwards: the stages come in the order the house is drawn in.
    const order = stages.map((stage) => HOUSE_STAGES.indexOf(stage));
    expect(order).toEqual([...order].sort((a, b) => a - b));
});

it(`stands at the plans before any phase, and at a phase it does not know`, () => {
    expect(houseStageOf({ state: `building`, phase: undefined })).toBe(`plan`);
    expect(houseStageOf({ state: `building`, phase: `sync-enrolling` })).toBe(`plan`);
});

it(`stands finished once ready, and as far as it got when it stopped`, () => {
    expect(houseStageOf({ state: `ready`, phase: `verifying` })).toBe(`home`);
    expect(houseStageOf({ state: `failed`, phase: `starting-sandbox` })).toBe(`walls`);
});

it(`shows every part a stage has reached, and none it has not`, () => {
    expect(reached(`roof`, `walls`)).toBe(true);
    expect(reached(`roof`, `roof`)).toBe(true);
    expect(reached(`roof`, `lit`)).toBe(false);
});

it(`stacks the materials as the image arrives, the first as soon as it starts`, () => {
    expect(blocksStacked(`plan`, 1, 6)).toBe(0);
    expect(blocksStacked(`ground`, 0, 6)).toBe(1);
    expect(blocksStacked(`ground`, 0.5, 6)).toBe(3);
    expect(blocksStacked(`ground`, 1, 6)).toBe(6);
    expect(blocksStacked(`ground`, Number.NaN, 6)).toBe(1);
    expect(blocksStacked(`walls`, 0, 6)).toBe(6);
});
