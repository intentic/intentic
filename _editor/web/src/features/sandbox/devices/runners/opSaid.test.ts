import { switchSaid, verdictSaid } from "./opSaid";

// The shape a resume answers with in plain mode: narration, Mutagen's own lines, a verdict naming pairing keys.
const RESUMED = [
    `intentic: resuming file sync…`,
    `Resuming session sync_k3Jx9AbCdEf...`,
    `Resuming session sync_q8Lm2GhIjKl...`,
    `intentic: Resumed file sync for work-abc:C:\\Users\\radar\\intentic\\work, work-abc:C:\\Users\\radar\\intentic\\work#back.`,
].join(`\n`);

it(`says the app's own sentence and keeps the machine's output behind it`, () => {
    expect(switchSaid(`File syncing resumed.`, RESUMED)).toEqual({ message: `File syncing resumed.`, detail: RESUMED });
});

// The daemon falls back to its own sentence when the CLI printed nothing: there is nothing more to show.
it(`has no details when the machine said nothing the line doesn't`, () => {
    expect(switchSaid(`File syncing resumed.`, ``)).toEqual({ message: `File syncing resumed.` });
    expect(switchSaid(`File syncing resumed.`, `File syncing resumed.`)).toEqual({ message: `File syncing resumed.` });
});

// Exit 0, and nothing resumed: the success sentence would be a lie, so the machine's verdict is the line.
it(`says the machine's own verdict when it had nothing to do`, () => {
    const idle = `intentic: resuming file sync…\nintentic: No file-sync session is running for work-abc, so nothing was resumed. Syncing starts when the sandbox answers again.`;
    expect(switchSaid(`File syncing resumed.`, idle)).toEqual({
        message: `No file-sync session is running for work-abc, so nothing was resumed. Syncing starts when the sandbox answers again.`,
        detail: idle,
        idle: true,
    });
    expect(switchSaid(`File syncing paused.`, `intentic: This enrollment only mirrors ports, so there is no file sync to pause.`).idle).toBe(true);
});

// Some sessions idle, the rest acted: a note about the idle ones, then the verdict that it worked.
it(`reads the last verdict, not a note about some sessions, as the outcome`, () => {
    const partial = `intentic: resuming file sync…\nintentic: No file-sync session to resume for work-abc:/x.\nintentic: Resumed file sync for work-abc:/y.`;
    expect(switchSaid(`File syncing resumed.`, partial)).toEqual({ message: `File syncing resumed.`, detail: partial });
});

it(`takes a container verb's first line as its verdict`, () => {
    expect(verdictSaid(`Stopped sandbox-1.\nlater  start it   ic sandbox start sandbox-1`)).toEqual({
        message: `Stopped sandbox-1.`,
        detail: `Stopped sandbox-1.\nlater  start it   ic sandbox start sandbox-1`,
    });
    expect(verdictSaid(`  Stopped sandbox-1.  `)).toEqual({ message: `Stopped sandbox-1.` });
});
