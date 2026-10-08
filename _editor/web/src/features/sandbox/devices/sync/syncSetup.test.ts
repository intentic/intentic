import { setupSaid } from "./syncSetup";

// What the machine answered when a workspace sync was set up from the Devices page (2026-10-08), every line as it came.
// The row printed all of it run together; what a reader under the row needs is the verdict and what is true of the folder.
const ANSWER = [
    `intentic: [sync-enrolling] enrolling this machine with your sandbox…`,
    `intentic: enrolled SSH key with https://sandbox-82789f4106b4.radarsu.com`,
    `intentic: [sync-linking] linking the folder to your sandbox…`,
    `intentic: [sync-starting] starting the sync engine…`,
    `intentic: This machine now syncs 2 pairings:`,
    `intentic:   sandbox-11cc5453ab77-radarsu-com → /home/radarsu/intentic/workspace-11cc5453ab77`,
    `intentic:   sandbox-82789f4106b4-radarsu-com → /home/radarsu/intentic/workspace-82789f4106b4`,
    `Desktop sync is running.`,
    `/home/radarsu/intentic/workspace-82789f4106b4`,
    `That folder and your sandbox's /work are kept the same from now on; the first copy can take a few minutes.`,
    `check it: intentic-machine status`,
    `remove it: intentic-machine sync uninstall`,
    ``,
].join(`\n`);

it(`keeps the verdict and what is true of the folder, and drops the narration and the commands to type`, () => {
    expect(setupSaid(ANSWER)).toBe(
        [
            `Desktop sync is running.`,
            `/home/radarsu/intentic/workspace-82789f4106b4`,
            `That folder and your sandbox's /work are kept the same from now on; the first copy can take a few minutes.`,
        ].join(`\n`),
    );
});

it(`keeps a note the machine adds about this folder`, () => {
    expect(setupSaid(`note: the sync transport isn't listening yet, syncing starts as soon as it is.\nDesktop sync is running.\r\n`)).toBe(
        `note: the sync transport isn't listening yet, syncing starts as soon as it is.\nDesktop sync is running.`,
    );
});

it(`drops a warning's indented continuation with the warning`, () => {
    expect(setupSaid(`intentic: something went sideways\n          and here is more of it\nDesktop sync is running.`)).toBe(`Desktop sync is running.`);
});
