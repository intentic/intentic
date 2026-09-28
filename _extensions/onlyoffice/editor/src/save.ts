// SPDX-License-Identifier: AGPL-3.0-only
import { CHANNEL, type ConflictChoice, type PageMessage } from "../../src/protocol.js";

// Saving without a document server. The editor holds the document; a save asks it to export the document in its own
// format (the offline build converts with x2t and posts the bytes back to this page), and the page writes them to the
// workspace file with the version it last saw. A file changed on disk meanwhile is never written over silently: the
// write answers "conflict" and the owner decides. Saves happen when asked (Ctrl+S, the Save button, the viewer leaving
// the document) and, while there are unsaved edits, once the reader has paused.

export type WriteKind =
    // Written only while the file is still `expected`, the version this page loaded or last wrote.
    | { readonly kind: "save"; readonly expected: string }
    | { readonly kind: "overwrite" }
    | { readonly kind: "copy" };

export type WriteOutcome =
    | { readonly written: true; readonly path: string; readonly version: string }
    | { readonly conflict: true }
    | { readonly failed: string };

export interface SaveEffects {
    // Asks the editor to export the document in its own format; false while it cannot yet (still loading, or busy
    // with a long action that would drop the request).
    readonly exportDocument: () => boolean;
    // Where the editor's change history stands, and marking a point of it as what the file holds now.
    readonly changePoint: () => number | undefined;
    readonly markSaved: (point: number | undefined) => void;
    readonly write: (bytes: ArrayBuffer, kind: WriteKind) => Promise<WriteOutcome>;
    // A file the reader exported themselves (File > Download as), handed to the browser as a download.
    readonly download: (bytes: ArrayBuffer, fileName: string) => void;
    // Loads the document again from the workspace, dropping what the editor holds.
    readonly reload: () => void;
    readonly post: (message: PageMessage) => void;
}

export interface SaveTiming {
    readonly now: () => number;
    // Runs `run` after `ms`; the answer cancels it.
    readonly schedule: (run: () => void, ms: number) => () => void;
}

export interface SaveOptions {
    // The document's own format, lowercase: an export in it while a save waits is the save's.
    readonly fileType: string;
    readonly version: string | undefined;
    // False for a document that is not written back at all (a read-only open, or a format x2t cannot write).
    readonly saveable: boolean;
    readonly effects: SaveEffects;
    readonly timing?: SaveTiming;
}

// Checked this often for a pause long enough to save in.
export const AUTOSAVE_TICK_MS = 5_000;
// How long the reader must have left the editor alone before an automatic save: an export blocks the editor while x2t
// runs, which is not something to do between two keystrokes.
export const IDLE_MS = 10_000;
// The least time between automatic saves, and between a failed save and the next automatic try.
export const MIN_GAP_MS = 30_000;
// An export the editor cannot take yet is asked again this often, for this long.
const EXPORT_RETRY_MS = 500;
export const EXPORT_RETRY_WINDOW_MS = 25_000;
// The exported bytes must arrive within this; a large document on a slow machine takes tens of seconds.
export const EXPORT_TIMEOUT_MS = 180_000;

type Phase = "idle" | "exporting" | "writing" | "conflict";

const realTiming: SaveTiming = {
    now: () => Date.now(),
    schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
    },
};

export class SaveController {
    private dirty = false;
    private ready = false;
    private phase: Phase = "idle";
    private pending: { readonly kind: WriteKind; readonly point: number | undefined } | undefined;
    private version: string | undefined;
    // A save asked for while another was under way: run once that one is done.
    private again = false;
    private lastInput = Number.NEGATIVE_INFINITY;
    private lastAttempt = Number.NEGATIVE_INFINITY;
    // The automatic save's own clock, apart from the timers of the save under way.
    private stopTicking: (() => void) | undefined;
    private readonly cancels = new Set<() => void>();
    private readonly timing: SaveTiming;

    constructor(private readonly options: SaveOptions) {
        this.version = options.version;
        this.timing = options.timing ?? realTiming;
    }

    // Whether leaving now would lose something: unsaved edits, a save under way, or a conflict nobody settled.
    get unsaved(): boolean {
        return this.dirty || this.phase !== "idle";
    }

    // The document is open: exports can be asked for, and the automatic save starts watching.
    opened(): void {
        if (this.ready) {
            return;
        }
        this.ready = true;
        this.stopTicking = this.timing.schedule(() => this.tick(), AUTOSAVE_TICK_MS);
    }

    // The editor's own "modified" flag changed.
    modified(flag: boolean): void {
        if (flag === this.dirty) {
            return;
        }
        this.dirty = flag;
        this.options.effects.post({ channel: CHANNEL, type: "dirty", dirty: flag });
    }

    // The reader typed, clicked or scrolled in the editor.
    touched(): void {
        this.lastInput = this.timing.now();
    }

    // A save someone asked for: the reader (Ctrl+S, the Save button) or the viewer leaving the document. It writes only
    // what changed; with nothing unsaved it does nothing.
    request(): void {
        if (!this.ready || !this.options.saveable || this.phase === "conflict") {
            return;
        }
        if (this.phase !== "idle") {
            this.again = true;
            return;
        }
        if (this.dirty) {
            this.start({ kind: "save", expected: this.version ?? "" });
        }
    }

    // The owner's answer to a conflict.
    resolve(choice: ConflictChoice): void {
        if (this.phase !== "conflict") {
            return;
        }
        this.phase = "idle";
        if (choice === "reload") {
            this.options.effects.reload();
            return;
        }
        this.start({ kind: choice });
    }

    // Bytes the editor exported. They are the save's when a save is waiting for its format; anything else is a file
    // the reader exported themselves.
    fileStream(bytes: ArrayBuffer, fileName: string, fileType: string): void {
        const pending = this.pending;
        if (this.phase !== "exporting" || pending === undefined) {
            this.options.effects.download(bytes, fileName);
            return;
        }
        if (fileType.toLowerCase() !== this.options.fileType) {
            this.options.effects.download(bytes, fileName);
            this.fail(`the editor exported ${fileType}, not ${this.options.fileType}`);
            return;
        }
        this.clearTimers();
        this.phase = "writing";
        void this.write(bytes, pending);
    }

    // Says again where things stand, for a viewer that was not listening when it changed.
    sync(): void {
        const { post } = this.options.effects;
        post({ channel: CHANNEL, type: "dirty", dirty: this.dirty });
        if (this.phase === "conflict") {
            post({ channel: CHANNEL, type: "conflict" });
        }
    }

    // An export that failed inside the editor (x2t refused the document) rather than never arriving.
    exportFailed(detail: string): void {
        if (this.phase === "exporting") {
            this.fail(detail);
        }
    }

    dispose(): void {
        this.stopTicking?.();
        this.clearTimers();
    }

    private tick(): void {
        const now = this.timing.now();
        const paused = now - this.lastInput >= IDLE_MS && now - this.lastAttempt >= MIN_GAP_MS;
        if (this.options.saveable && this.dirty && this.phase === "idle" && paused) {
            this.start({ kind: "save", expected: this.version ?? "" });
        }
        this.stopTicking = this.timing.schedule(() => this.tick(), AUTOSAVE_TICK_MS);
    }

    private start(kind: WriteKind): void {
        this.phase = "exporting";
        this.again = false;
        this.lastAttempt = this.timing.now();
        this.pending = { kind, point: this.options.effects.changePoint() };
        this.later(() => this.fail(`the editor did not hand over the document in time`), EXPORT_TIMEOUT_MS);
        this.tryExport(this.lastAttempt + EXPORT_RETRY_WINDOW_MS);
    }

    private tryExport(deadline: number): void {
        if (this.phase !== "exporting" || this.options.effects.exportDocument()) {
            return;
        }
        if (this.timing.now() >= deadline) {
            this.fail(`the editor stayed busy and could not export the document`);
            return;
        }
        this.later(() => this.tryExport(deadline), EXPORT_RETRY_MS);
    }

    private async write(bytes: ArrayBuffer, pending: { readonly kind: WriteKind; readonly point: number | undefined }): Promise<void> {
        const { effects } = this.options;
        const outcome = await effects.write(bytes, pending.kind);
        this.pending = undefined;
        if ("conflict" in outcome) {
            this.phase = "conflict";
            effects.post({ channel: CHANNEL, type: "conflict" });
            return;
        }
        if ("failed" in outcome) {
            this.phase = "idle";
            effects.post({ channel: CHANNEL, type: "save-failed", detail: outcome.failed });
            return;
        }
        this.phase = "idle";
        effects.post({ channel: CHANNEL, type: "saved", path: outcome.path });
        if (pending.kind.kind === "copy") {
            // The edits are in the copy now; the document shows what is on disk, the change the owner chose to keep.
            effects.reload();
            return;
        }
        this.version = outcome.version;
        // Clears the editor's modified flag, unless the reader typed on while the save ran.
        effects.markSaved(pending.point);
        if (this.again) {
            this.again = false;
            this.start({ kind: "save", expected: this.version });
        }
    }

    private fail(detail: string): void {
        this.clearTimers();
        this.pending = undefined;
        this.again = false;
        this.phase = "idle";
        // The automatic save tries again MIN_GAP_MS after this attempt, not at once.
        this.options.effects.post({ channel: CHANNEL, type: "save-failed", detail });
    }

    private later(run: () => void, ms: number): void {
        const cancel = this.timing.schedule(() => {
            this.cancels.delete(cancel);
            run();
        }, ms);
        this.cancels.add(cancel);
    }

    private clearTimers(): void {
        for (const cancel of this.cancels) {
            cancel();
        }
        this.cancels.clear();
    }
}
