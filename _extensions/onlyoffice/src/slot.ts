import type { DocsState, OpenRequest, OpenResult } from "./contract.js";
import { frameId, keep, take, type KeptFrame } from "./frames.js";

// The viewer's editor frame, kept out of the component so the one rule that matters can be tested: an editor kept from
// an earlier visit is shown at once but stays inert until the backend vouches that it still holds the file, and one
// the backend does not vouch for is thrown away for a new one.

export interface SlotDeps {
    readonly open: (request: OpenRequest) => Promise<OpenResult>;
    // The address to frame for the public one the backend built (the host's `previewAddress`).
    readonly address: (url: string) => Promise<string>;
    // Writes what a session's editor holds to the workspace now.
    readonly forceSave: (session: string) => Promise<void>;
    // Told whenever a frame enters or leaves the slot, so the viewer shows the frame or its card.
    readonly framed: (framed: boolean) => void;
}

export interface Opening {
    readonly path: string;
    readonly agent: string | undefined;
    readonly mode: `edit` | `view`;
    readonly theme: `light` | `dark`;
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

export class EditorSlot {
    private current: Current | undefined;
    private generation = 0;

    constructor(
        private readonly element: HTMLElement,
        private readonly deps: SlotDeps,
    ) {}

    // Puts the editor for `opening` in the slot: the one kept from before at once, inert until the backend answers,
    // else a new one once the backend has a session for it. Throws what the backend threw, unless superseded.
    async load(opening: Opening): Promise<Loaded> {
        const mine = ++this.generation;
        const id = frameId(opening.path, opening.agent, opening.mode, opening.theme);
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
        this.show({ frame, session: result.session, id, mode: opening.mode });
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
        if (!keep(leaving.id, leaving)) {
            leaving.frame.remove();
            return;
        }
        if (leaving.mode === `edit`) {
            // silent-catch: a forced save that did not happen is the one the server makes when the editor closes.
            this.deps.forceSave(leaving.session).catch(() => undefined);
        }
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
