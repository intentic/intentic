// SPDX-License-Identifier: AGPL-3.0-only
import { CHANNEL, type PageMessage } from "../../src/protocol.js";
import { AUTOSAVE_TICK_MS, EXPORT_RETRY_WINDOW_MS, EXPORT_TIMEOUT_MS, IDLE_MS, MIN_GAP_MS, SaveController, type WriteKind, type WriteOutcome } from "./save.js";

// The save controller against a scripted editor and workspace, on a clock the test moves: what it exports and writes,
// when it saves on its own, and how a conflict is held until the owner answers.

class Clock {
    now = 0;
    private timers: { at: number; run: () => void; live: boolean }[] = [];

    schedule = (run: () => void, ms: number): (() => void) => {
        const timer = { at: this.now + ms, run, live: true };
        this.timers.push(timer);
        return () => {
            timer.live = false;
        };
    };

    // Moves time on, running every timer that falls due on the way, in order.
    advance(ms: number): void {
        const end = this.now + ms;
        for (;;) {
            const due = this.timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
            if (due === undefined) {
                break;
            }
            due.live = false;
            this.now = due.at;
            due.run();
        }
        this.now = end;
        this.timers = this.timers.filter((timer) => timer.live);
    }
}

interface Rig {
    readonly save: SaveController;
    readonly clock: Clock;
    readonly posted: PageMessage[];
    readonly writes: WriteKind[];
    readonly marked: (number | undefined)[];
    readonly downloads: string[];
    exports: number;
    reloads: number;
    // Whether the editor takes an export right now, the change point it reports, and what the next write answers.
    exportable: boolean;
    point: number;
    outcome: WriteOutcome;
}

const rig = (options: { saveable?: boolean; version?: string } = {}): Rig => {
    const clock = new Clock();
    const state: Omit<Rig, `save`> = {
        clock,
        posted: [],
        writes: [],
        marked: [],
        downloads: [],
        exports: 0,
        reloads: 0,
        exportable: true,
        point: 1,
        outcome: { written: true, path: `brief.docx`, version: `v2` },
    };
    const save = new SaveController({
        fileType: `docx`,
        version: `version` in options ? options.version : `v1`,
        saveable: options.saveable ?? true,
        timing: { now: () => clock.now, schedule: clock.schedule },
        effects: {
            exportDocument: () => {
                if (state.exportable) {
                    state.exports += 1;
                }
                return state.exportable;
            },
            changePoint: () => state.point,
            markSaved: (point) => state.marked.push(point),
            write: async (_bytes, kind) => {
                state.writes.push(kind);
                return state.outcome;
            },
            download: (_bytes, fileName) => state.downloads.push(fileName),
            reload: () => {
                state.reloads += 1;
            },
            post: (message) => state.posted.push(message),
        },
    });
    return Object.assign(state, { save });
};

const bytes = new ArrayBuffer(4);
// Lets the write's promise settle.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const types = (posted: readonly PageMessage[]): string[] => posted.map((message) => message.type);

// An open document with one unsaved edit.
const edited = (options: Parameters<typeof rig>[0] = {}): Rig => {
    const r = rig(options);
    r.save.opened();
    r.save.modified(true);
    return r;
};

describe(`a save someone asks for`, () => {
    it(`exports, writes against the version last seen, and marks the edits saved up to the export`, async () => {
        const r = edited();
        r.point = 7;
        r.save.request();
        expect(r.exports).toBe(1);
        r.point = 9;
        r.save.fileStream(bytes, `brief.docx`, `DOCX`);
        await settle();
        expect(r.writes).toEqual([{ kind: `save`, expected: `v1` }]);
        expect(r.marked).toEqual([7]);
        expect(r.posted).toEqual([
            { channel: CHANNEL, type: `dirty`, dirty: true },
            { channel: CHANNEL, type: `saved`, path: `brief.docx` },
        ]);
        // The next save names the version this one left.
        r.save.request();
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.writes[1]).toEqual({ kind: `save`, expected: `v2` });
    });

    it(`does nothing with no unsaved edits, before the document is open, or for a document that is not written back`, () => {
        const clean = rig();
        clean.save.opened();
        clean.save.request();
        const unopened = rig();
        unopened.save.modified(true);
        unopened.save.request();
        const readOnly = edited({ saveable: false });
        readOnly.save.request();
        expect([clean.exports, unopened.exports, readOnly.exports]).toEqual([0, 0, 0]);
    });

    it(`runs once more after the save under way when asked again meanwhile`, async () => {
        const r = edited();
        r.save.request();
        r.save.request();
        expect(r.exports).toBe(1);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.exports).toBe(2);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.writes).toEqual([
            { kind: `save`, expected: `v1` },
            { kind: `save`, expected: `v2` },
        ]);
    });
});

describe(`an export the editor cannot take at once`, () => {
    it(`is asked again until the editor takes it`, () => {
        const r = edited();
        r.exportable = false;
        r.save.request();
        r.clock.advance(1_000);
        expect(r.exports).toBe(0);
        r.exportable = true;
        r.clock.advance(500);
        expect(r.exports).toBe(1);
        expect(r.save.unsaved).toBe(true);
    });

    it(`fails once the editor stayed busy for the whole window, and when its bytes never come`, () => {
        const busy = edited();
        busy.exportable = false;
        busy.save.request();
        busy.clock.advance(EXPORT_RETRY_WINDOW_MS);
        expect(busy.posted.at(-1)).toEqual({ channel: CHANNEL, type: `save-failed`, detail: `the editor stayed busy and could not export the document` });
        const silent = edited();
        silent.save.request();
        silent.clock.advance(EXPORT_TIMEOUT_MS);
        expect(silent.posted.at(-1)).toEqual({ channel: CHANNEL, type: `save-failed`, detail: `the editor did not hand over the document in time` });
    });

    it(`fails when the editor reports the conversion failed`, () => {
        const r = edited();
        r.save.request();
        r.save.exportFailed(`Conversion failed with code 88`);
        expect(r.posted.at(-1)).toEqual({ channel: CHANNEL, type: `save-failed`, detail: `Conversion failed with code 88` });
        expect(r.save.unsaved).toBe(true);
    });
});

describe(`the bytes the editor exports`, () => {
    it(`are a download when no save waits for them`, () => {
        const r = edited();
        r.save.fileStream(bytes, `brief.pdf`, `pdf`);
        expect(r.downloads).toEqual([`brief.pdf`]);
        expect(r.writes).toEqual([]);
    });

    it(`are a download, and the save a failure, when they come in another format than the document's`, () => {
        const r = edited();
        r.save.request();
        r.save.fileStream(bytes, `brief.pdf`, `pdf`);
        expect(r.downloads).toEqual([`brief.pdf`]);
        expect(r.writes).toEqual([]);
        expect(r.posted.at(-1)).toEqual({ channel: CHANNEL, type: `save-failed`, detail: `the editor exported pdf, not docx` });
    });
});

describe(`saving on its own`, () => {
    it(`saves once the reader has paused, and not while they are still working`, async () => {
        const r = edited();
        r.save.touched();
        r.clock.advance(IDLE_MS - 1);
        expect(r.exports).toBe(0);
        // Still typing at the end of that stretch: the pause starts over.
        r.save.touched();
        r.clock.advance(IDLE_MS - 1);
        expect(r.exports).toBe(0);
        r.clock.advance(AUTOSAVE_TICK_MS);
        expect(r.exports).toBe(1);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.writes).toEqual([{ kind: `save`, expected: `v1` }]);
    });

    it(`leaves at least MIN_GAP_MS between automatic saves, and after a failed one`, async () => {
        const r = edited();
        r.outcome = { failed: `the sandbox answered 500` };
        r.clock.advance(IDLE_MS);
        expect(r.exports).toBe(1);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.posted.at(-1)).toEqual({ channel: CHANNEL, type: `save-failed`, detail: `the sandbox answered 500` });
        r.clock.advance(MIN_GAP_MS - AUTOSAVE_TICK_MS - 1);
        expect(r.exports).toBe(1);
        r.clock.advance(AUTOSAVE_TICK_MS + 1);
        expect(r.exports).toBe(2);
    });

    it(`does nothing while nothing is unsaved`, () => {
        const r = rig();
        r.save.opened();
        r.clock.advance(MIN_GAP_MS * 4);
        expect(r.exports).toBe(0);
    });
});

describe(`a file changed on disk meanwhile`, () => {
    const conflicted = async (): Promise<Rig> => {
        const r = edited();
        r.outcome = { conflict: true };
        r.save.request();
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        return r;
    };

    it(`is not written over: the owner is asked, and saves wait on the answer`, async () => {
        const r = await conflicted();
        expect(types(r.posted)).toEqual([`dirty`, `conflict`]);
        expect(r.marked).toEqual([]);
        r.save.request();
        r.clock.advance(MIN_GAP_MS * 2);
        expect(r.exports).toBe(1);
        expect(r.save.unsaved).toBe(true);
    });

    it(`is written over when the owner keeps their version`, async () => {
        const r = await conflicted();
        r.outcome = { written: true, path: `brief.docx`, version: `v3` };
        r.save.resolve(`overwrite`);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.writes).toEqual([{ kind: `save`, expected: `v1` }, { kind: `overwrite` }]);
        expect(r.posted.at(-1)).toEqual({ channel: CHANNEL, type: `saved`, path: `brief.docx` });
        expect(r.marked).toEqual([1]);
    });

    it(`is kept, with the edits written beside it, when the owner keeps both`, async () => {
        const r = await conflicted();
        r.outcome = { written: true, path: `brief (copy).docx`, version: `c1` };
        r.save.resolve(`copy`);
        r.save.fileStream(bytes, `brief.docx`, `docx`);
        await settle();
        expect(r.writes.at(-1)).toEqual({ kind: `copy` });
        expect(r.posted.at(-1)).toEqual({ channel: CHANNEL, type: `saved`, path: `brief (copy).docx` });
        expect(r.reloads).toBe(1);
    });

    it(`is loaded, and the edits dropped, when the owner takes the change on disk`, async () => {
        const r = await conflicted();
        r.save.resolve(`reload`);
        expect(r.reloads).toBe(1);
        expect(r.writes).toHaveLength(1);
    });

    it(`ignores an answer when nothing is in conflict`, () => {
        const r = edited();
        r.save.resolve(`overwrite`);
        expect(r.exports).toBe(0);
    });
});

describe(`the unsaved flag`, () => {
    it(`tells the viewer only when it changes`, () => {
        const r = rig();
        r.save.modified(false);
        r.save.modified(true);
        r.save.modified(true);
        r.save.modified(false);
        expect(r.posted).toEqual([
            { channel: CHANNEL, type: `dirty`, dirty: true },
            { channel: CHANNEL, type: `dirty`, dirty: false },
        ]);
        expect(r.save.unsaved).toBe(false);
    });
});
