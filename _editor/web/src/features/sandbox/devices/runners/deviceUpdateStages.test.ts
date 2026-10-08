// What an update's stream says about where it is. The lines are `ic`'s own (recreate.rs, preflight.rs, backup.rs) and
// docker's non-interactive pull, as a machine streams them to the Devices page.
import { type DeviceUpdateRun, foldUpdateLine, settleUpdateRun, startUpdateRun, updateDetail } from "./deviceUpdateStages";

const fold = (run: DeviceUpdateRun, lines: readonly string[], at = 0): DeviceUpdateRun =>
    lines.reduce((acc, line, index) => foldUpdateLine(acc, line, at + index), run);

const PULL = [
    `intentic: pulling ghcr.io/intentic/sandbox:stable…`,
    `stable: Pulling from intentic/sandbox`,
    `aaaaaaaaaaaa: Already exists`,
    `bbbbbbbbbbbb: Pulling fs layer`,
    `cccccccccccc: Pulling fs layer`,
    `dddddddddddd: Pulling fs layer`,
    `bbbbbbbbbbbb: Download complete`,
    `bbbbbbbbbbbb: Pull complete`,
];

const SWAP = [
    `intentic: pre-flighting the state conversions of ghcr.io/intentic/sandbox:stable on this sandbox's data (read-only)…`,
    `intentic: backed up sandbox-574ea8038415's state before the swap (snapshot 479bdfba).`,
    `intentic: recreating the sandbox from ghcr.io/intentic/sandbox:stable…`,
    `intentic: waiting for the sandbox daemon to come up…`,
];

it(`starts an update on its download, timed from the press`, () => {
    const run = startUpdateRun(`update`, 1000);
    expect(run.stage).toBe(`download`);
    expect(run.stageAt).toEqual({ download: 1000 });
    expect(run.fraction).toBe(0);
});

it(`says nothing of layers while docker is still naming them`, () => {
    const run = fold(startUpdateRun(`update`, 0), PULL.slice(0, 6));
    expect(run.fraction).toBe(0);
    expect(updateDetail(run)).toBe(`pulling ghcr.io/intentic/sandbox:stable…`);
});

it(`counts docker's layers as the download's own fraction`, () => {
    const run = fold(startUpdateRun(`update`, 0), PULL);
    expect(run.stage).toBe(`download`);
    expect(updateDetail(run)).toBe(`2 of 4 layers`);
    // Half of a step that is 0.6 of the whole.
    expect(run.fraction).toBeCloseTo(0.3);
    expect(run.lines).toHaveLength(PULL.length);
});

it(`moves through the checks to the swap, timing each step from its first line`, () => {
    const run = fold(startUpdateRun(`update`, 0), [...PULL, ...SWAP], 100);
    expect(run.stage).toBe(`swap`);
    expect(run.stageAt.check).toBe(100 + PULL.length);
    expect(run.stageAt.swap).toBe(100 + PULL.length + 2);
    expect(updateDetail(run)).toBe(`waiting for the sandbox daemon to come up…`);
    expect(run.fraction).toBeCloseTo(0.75);
});

it(`reads an update prepared earlier as a download with nothing in it`, () => {
    const run = fold(startUpdateRun(`update`, 0), [
        `stable: Pulling from intentic/sandbox`,
        `Digest: sha256:1366a71da67cabd5d9f5c90d3b3a4181d861c7b29decc57cc0201c546317ab60`,
        `Status: Image is up to date for ghcr.io/intentic/sandbox:stable`,
        `intentic: using the update prepared earlier — nothing to download.`,
    ]);
    expect(run.stage).toBe(`download`);
    expect(updateDetail(run)).toBe(`using the update prepared earlier — nothing to download.`);
});

it(`never walks back a step for the health lines and docker output inside the swap`, () => {
    const run = fold(startUpdateRun(`update`, 0), [
        ...SWAP,
        `eeeeeeeeeeee: Pull complete`,
        `intentic:   checking the daemon…`,
        `intentic: pulling something…`,
    ]);
    expect(run.stage).toBe(`swap`);
    expect(run.layers).toEqual({});
    expect(updateDetail(run)).toBe(`waiting for the sandbox daemon to come up…`);
});

it(`keeps ic's unrecognised sentences as the running step's latest word`, () => {
    const run = fold(startUpdateRun(`update`, 0), [`intentic: another ic run is working on demo — waiting for it to finish…`]);
    expect(run.stage).toBe(`download`);
    expect(updateDetail(run)).toBe(`another ic run is working on demo — waiting for it to finish…`);
});

it(`draws a rollback without a download step`, () => {
    const run = startUpdateRun(`rollback`, 0);
    expect(run.stage).toBe(`check`);
    const rolled = fold(run, [
        `intentic: rolling back to intentic-sandbox-pin:1.2.0…`,
        `intentic: x is not on this machine any more — pulling it…`,
        ...SWAP,
    ]);
    expect(rolled.stage).toBe(`swap`);
});

it(`settles a finished update whole, and one that found nothing newer where it stopped`, () => {
    const updated = settleUpdateRun(
        fold(startUpdateRun(`update`, 0), [...SWAP, `intentic: sandbox updated to ghcr.io/intentic/sandbox:stable (channel stable).`]),
        true,
        true,
        50,
    );
    expect(updated.phase).toBe(`done`);
    expect(updated.fraction).toBe(1);

    const current = settleUpdateRun(
        fold(startUpdateRun(`update`, 0), [
            `intentic: no newer sandbox image is available yet — your sandbox is already on the latest :stable it can pull.`,
        ]),
        true,
        false,
        50,
    );
    expect(current.phase).toBe(`done`);
    expect(current.stage).toBe(`download`);
    expect(current.fraction).toBeLessThan(1);
});

it(`calls an update whose stream went down with the sandbox before it came up severed, not done`, () => {
    const run = settleUpdateRun(fold(startUpdateRun(`update`, 0), SWAP), true, true, 50);
    expect(run.phase).toBe(`severed`);
    expect(run.endedAt).toBe(50);
});

it(`settles a refusal as failed where it stood`, () => {
    const run = settleUpdateRun(fold(startUpdateRun(`update`, 0), PULL), false, false, 9);
    expect(run.phase).toBe(`failed`);
    expect(run.stage).toBe(`download`);
});
