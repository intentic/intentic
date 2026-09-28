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

interface Current extends KeptFrame {
    readonly id: string;
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
                this.show({ ...kept, id, mode: opening.mode });
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
        this.show({ frame, session: result.session, engine: result.engine, origin: new URL(address).origin, id, mode: opening.mode });
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
        if (!keep(leaving.id, leaving)) {
            leaving.frame.remove();
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

    // Tells the page in the slot how the owner settled a conflict.
    resolve(choice: ConflictChoice): void {
        if (this.current?.engine === `browser`) {
            tell(this.current, { channel: CHANNEL, type: `resolve`, choice });
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
        this.deps.framed(true);
    }

    private discard(): void {
        if (this.current === undefined) {
            return;
        }
        this.current.frame.remove();
        this.current = undefined;
        this.deps.framed(false);
    }
}
