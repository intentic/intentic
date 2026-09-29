import { sandboxValue } from "@intentic/extension-api";
import type { DocsState, Engine, OpenRequest, OpenResult } from "./contract.js";
import { frameId, keep, take, type KeptFrame } from "./frames.js";
import { CHANNEL, pageMessage, type ConflictChoice, type PageMessage, type ViewerMessage } from "./protocol.js";

// The viewer's editor frame, kept out of the component so the one rule that matters can be tested: an editor kept from
// an earlier visit is shown at once but stays inert until the backend vouches that it still holds the file, and one
// the backend does not vouch for is thrown away for a new one. A browser-engine editor is told things (save, how a
// conflict was settled) by message, and what it says back reaches the viewer only from the frame it came from.

export interface SlotDeps {
    readonly open: (request: OpenRequest) => Promise<OpenResult>;
    // The address to frame for the public one the backend built (the host's `previewAddress`).
    readonly address: (url: string) => Promise<string>;
    // Asks the document server to write what a session's editor holds, now.
    readonly forceSave: (session: string) => Promise<void>;
    // Told whenever a frame enters or leaves the slot, so the viewer shows the frame or its card.
    readonly framed: (framed: boolean) => void;
    // What the browser engine's page in the slot says.
    readonly message: (message: PageMessage) => void;
}

export interface Opening {
    readonly path: string;
    readonly agent: string | undefined;
    readonly mode: `edit` | `view`;
    readonly theme: `light` | `dark`;
    readonly engine: Engine;
    // The app's language and origin, for the browser engine's page.
    readonly lang: string;
    readonly origin: string;
}

// What a load came to: the editor is in the slot, the state that stands in the way, or nothing because a later load
// (another document, the viewer going) took over.
export type Loaded = { readonly framed: true } | { readonly status: DocsState } | { readonly superseded: true };

// What decides the mode a document opens in.
export interface ModeRules {
    // Whether the reader may edit this document here at all: their role, the copy it is read from, the host's word.
    readonly mayEdit: boolean;
    // The backend asked for documents to open for reading first (`openAs: "view"`, a desktop app's local window).
    readonly viewFirst: boolean;
    // The reader pressed Edit on this document.
    readonly editAsked: boolean;
}

// A document the reader may edit opens for editing, unless the backend asked for reading first and the reader has not
// pressed Edit yet.
export const openingMode = (rules: ModeRules): Opening[`mode`] => (rules.mayEdit && (!rules.viewFirst || rules.editAsked) ? `edit` : `view`);

// Edit is offered on a document opened for reading first, which the reader may edit, in a format the engine can write
// back (`formatWritable`: the browser engine can't write the legacy binary ones), and hasn't asked to edit yet.
export const offersEdit = (rules: ModeRules, formatWritable: boolean): boolean => rules.viewFirst && rules.mayEdit && formatWritable && !rules.editAsked;

// The documents the reader pressed Edit on, for as long as the page looks at this sandbox: coming back to one opens it
// for editing again, in the editor kept alive for it if it still is.
const editsChosen = sandboxValue(() => new Set<string>());
export const editChosen = (path: string): boolean => editsChosen.value.has(path);
export const chooseEdit = (path: string): void => {
    editsChosen.value.add(path);
};

/* UNSAVED EDITS, BY THE EDITOR THAT HOLDS THEM. Every editor frame this page runs, in a slot or kept out of sight
   (frames.ts), with what its page last said about edits its file doesn't have; and per document, where the host is
   told. Apart from any one EditorSlot on purpose: a kept editor saves, fails or meets a conflict after its viewer has
   gone, and what it holds counts until its page says it is written, the reader discards it, or the frame goes. */

// The host's word on a document: told whether any editor of it holds unsaved edits, whenever that may have changed.
export type UnsavedReport = (dirty: boolean) => void;

interface Tracked {
    readonly path: string;
    readonly origin: string;
    dirty: boolean;
}

const unsaved = sandboxValue(
    () => ({ frames: new Map<HTMLIFrameElement, Tracked>(), reports: new Map<string, UnsavedReport>() }),
    // A switch ends every editor of the sandbox left (frames.ts), and what they held with them.
    (previous) => {
        for (const path of new Set([...previous.frames.values()].filter((entry) => entry.dirty).map((entry) => entry.path))) {
            previous.reports.get(path)?.(false);
        }
    },
);

const reportUnsavedOf = (path: string): void => {
    let dirty = false;
    for (const [frame, entry] of unsaved.value.frames) {
        // A frame no longer on the page runs no editor: what it held went with it.
        if (!frame.isConnected) {
            unsaved.value.frames.delete(frame);
        } else if (entry.path === path && entry.dirty) {
            dirty = true;
        }
    }
    unsaved.value.reports.get(path)?.(dirty);
};

/** Where the host is told about `path`'s unsaved edits, from now on; told where they stand at once. */
export const reportUnsaved = (path: string, report: UnsavedReport): void => {
    unsaved.value.reports.set(path, report);
    reportUnsavedOf(path);
};

// What a tracked frame's page says about its edits. `saved` of the document itself says nothing about them: the reader
// may have typed on while it ran, and the page's own `dirty` says how things stand after it. Saved beside the document
// (a conflict's copy), the page loads the file as it is on disk, and holds nothing.
const heardUnsaved = (event: MessageEvent): void => {
    for (const [frame, entry] of unsaved.value.frames) {
        if (event.source !== frame.contentWindow || event.origin !== entry.origin) {
            continue;
        }
        const message = pageMessage(event.data);
        if (message?.type === `dirty`) {
            entry.dirty = message.dirty;
            reportUnsavedOf(entry.path);
        } else if (message?.type === `saved` && message.path !== entry.path) {
            entry.dirty = false;
            reportUnsavedOf(entry.path);
        }
        return;
    }
};

// One listener for every tracked frame, from the first on: a kept frame has no slot listening for it.
let hearing = false;
const track = (frame: HTMLIFrameElement, path: string, origin: string): void => {
    if (!hearing) {
        hearing = true;
        window.addEventListener(`message`, heardUnsaved);
    }
    if (!unsaved.value.frames.has(frame)) {
        unsaved.value.frames.set(frame, { path, origin, dirty: false });
    }
};

// Whether the frame's editor holds edits its file doesn't have.
const holding = (frame: HTMLIFrameElement): boolean => unsaved.value.frames.get(frame)?.dirty === true;

// The frame's edits are gone: the frame with them (dropped, discarded, not kept), or at the reader's word (`clean`).
const forget = (frame: HTMLIFrameElement, { clean = false }: { readonly clean?: boolean } = {}): void => {
    const entry = unsaved.value.frames.get(frame);
    if (entry === undefined) {
        return;
    }
    if (clean) {
        entry.dirty = false;
    } else {
        unsaved.value.frames.delete(frame);
    }
    reportUnsavedOf(entry.path);
};

interface Current extends KeptFrame {
    readonly id: string;
    readonly path: string;
    readonly mode: Opening[`mode`];
}

const frameFor = (url: string, title: string): HTMLIFrameElement => {
    const frame = document.createElement(`iframe`);
    frame.src = url;
    frame.title = title;
    frame.allow = `clipboard-read; clipboard-write`;
    frame.style.cssText = `display:block;width:100%;height:100%;border:0`;
    return frame;
};

// Tells a browser-engine page something, addressed to its own origin so nothing else can read it.
const tell = (kept: KeptFrame, message: ViewerMessage): void => {
    kept.frame.contentWindow?.postMessage(message, kept.origin);
};

export class EditorSlot {
    private current: Current | undefined;
    private generation = 0;
    private readonly listen = (event: MessageEvent): void => {
        const current = this.current;
        if (current === undefined || event.source !== current.frame.contentWindow || event.origin !== current.origin) {
            return;
        }
        const message = pageMessage(event.data);
        if (message !== undefined) {
            this.deps.message(message);
        }
    };

    constructor(
        private readonly element: HTMLElement,
        private readonly deps: SlotDeps,
    ) {
        window.addEventListener(`message`, this.listen);
    }

    // Puts the editor for `opening` in the slot: the one kept from before at once, inert until the backend answers,
    // else a new one once the backend has a session for it. Throws what the backend threw, unless superseded.
    async load(opening: Opening): Promise<Loaded> {
        const mine = ++this.generation;
        const id = frameId(opening.path, opening.agent, opening.mode, opening.theme, opening.engine);
        if (this.current === undefined) {
            const kept = take(id, this.element);
            if (kept !== undefined) {
                kept.frame.toggleAttribute(`inert`, true);
                this.show({ ...kept, id, path: opening.path, mode: opening.mode });
            }
        }
        const resume = this.current?.session;
        let result: OpenResult;
        try {
            result = await this.deps.open({
                path: opening.path,
                ...(opening.agent === undefined ? {} : { agent: opening.agent }),
                mode: opening.mode,
                theme: opening.theme,
                engine: opening.engine,
                lang: opening.lang,
                origin: opening.origin,
                ...(resume === undefined ? {} : { resume }),
            });
        } catch (error) {
            if (mine !== this.generation) {
                return { superseded: true };
            }
            this.discard();
            throw error;
        }
        if (mine !== this.generation) {
            return { superseded: true };
        }
        if (`resumed` in result && this.current !== undefined) {
            this.current.frame.toggleAttribute(`inert`, false);
            // It may have saved, failed or met a conflict while nobody was listening.
            if (this.current.engine === `browser`) {
                tell(this.current, { channel: CHANNEL, type: `sync` });
            }
            return { framed: true };
        }
        // The kept editor holds something else now (the file changed, the server restarted): it goes.
        this.discard();
        if (`status` in result) {
            return { status: result.status };
        }
        if (!(`url` in result)) {
            throw new Error(`the backend resumed an editor this viewer does not hold`);
        }
        const address = await this.deps.address(result.url);
        if (mine !== this.generation) {
            return { superseded: true };
        }
        const frame = frameFor(address, opening.path);
        this.element.append(frame);
        this.show({ frame, session: result.session, engine: result.engine, origin: new URL(address).origin, id, path: opening.path, mode: opening.mode });
        return { framed: true };
    }

    // Leaves the document in the slot: its editor is kept for a quick return, and what was typed is written to the
    // workspace now, since a kept editor would otherwise hold it until it finally closes. Best effort both: a frame
    // that cannot be kept goes as it always did, and a forced save that fails is the one the server makes on close.
    leave(): void {
        this.generation++;
        const leaving = this.current;
        this.current = undefined;
        this.deps.framed(false);
        if (leaving === undefined) {
            return;
        }
        leaving.frame.toggleAttribute(`inert`, false);
        if (leaving.mode === `edit` && leaving.engine === `browser`) {
            // Told before it moves: a page that cannot be kept goes with its viewer, and is still told to save first.
            tell(leaving, { channel: CHANNEL, type: `save` });
        }
        // Kept, its editor still counts for what it holds, and is not let go while it holds anything.
        const { frame } = leaving;
        if (!keep(leaving.id, { ...leaving, holding: () => holding(frame), dropped: () => forget(frame) })) {
            frame.remove();
            forget(frame);
            return;
        }
        if (leaving.mode === `edit` && leaving.engine === `server`) {
            // allow(silent-catch): a forced save that did not happen is the one the server makes when the editor closes.
            this.deps.forceSave(leaving.session).catch(() => undefined);
        }
    }

    // Asks the page in the slot to write what it holds (after a failed save, say).
    save(): void {
        if (this.current?.engine === `browser`) {
            tell(this.current, { channel: CHANNEL, type: `save` });
        }
    }

    // Tells the page in the slot how the owner settled a conflict. Discard mine drops the edits at the owner's word: the
    // page loads the file as it is on disk.
    resolve(choice: ConflictChoice): void {
        if (this.current?.engine === `browser`) {
            tell(this.current, { channel: CHANNEL, type: `resolve`, choice });
            if (choice === `reload`) {
                forget(this.current.frame, { clean: true });
            }
        }
    }

    // Throws the editor in the slot away, for a fresh one on the next load: its document failed to open.
    reset(): void {
        this.discard();
    }

    dispose(): void {
        window.removeEventListener(`message`, this.listen);
    }

    private show(current: Current): void {
        this.current = current;
        track(current.frame, current.path, current.origin);
        this.deps.framed(true);
    }

    private discard(): void {
        if (this.current === undefined) {
            return;
        }
        this.current.frame.remove();
        forget(this.current.frame);
        this.current = undefined;
        this.deps.framed(false);
    }
}
