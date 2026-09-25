import { sandboxValue } from "@intentic/extension-api";

// Editors kept alive after their viewer goes: a tab switched away from, a tab closed. The frame is moved, not copied,
// into a hidden lot with `Element.moveBefore`, which keeps an iframe's document running where `appendChild` would
// reload it, and moved back when a viewer for the same document mounts. Going back to a document then shows the live
// editor at once instead of booting ONLYOFFICE and reloading the file. A browser without `moveBefore` keeps nothing:
// the frame goes with its viewer, as it always did.

export interface KeptFrame {
    readonly frame: HTMLIFrameElement;
    // The session the frame's editor runs under: what the backend is asked about before the frame is trusted again.
    readonly session: string;
}

interface Parked extends KeptFrame {
    readonly timer: ReturnType<typeof setTimeout>;
}

type Movable = Element & { moveBefore(node: Node, child: Node | null): void };

// Enough to go back and forth among a few documents. Each kept editor holds a few hundred MB of the browser's memory
// and a session on the document server, so both are bounded, and an editor nobody came back to is let go.
export const MAX_KEPT = 3;
export const KEEP_MS = 10 * 60_000;

// Oldest first: a Map iterates in insertion order, and a document kept again is re-inserted. Scoped to the sandbox the
// editors were opened in: a switch ends them all, since the next sandbox's backend vouches for none of them and their
// sockets would only hold the last sandbox's document server up.
const parked = sandboxValue(
    () => new Map<string, Parked>(),
    (previous) => {
        for (const found of previous.values()) {
            clearTimeout(found.timer);
            found.frame.remove();
        }
    },
);

// The lot is found by its id rather than held: it is the page's, not any one sandbox's.
const LOT_ID = `intentic-onlyoffice-kept`;

export const canKeep = (): boolean => typeof (Element.prototype as Partial<Movable>).moveBefore === `function`;

// What makes two opens the same editor: the document, the copy it is read from, and what the editor was built with.
export const frameId = (path: string, agent: string | undefined, mode: `edit` | `view`, theme: `light` | `dark`): string =>
    JSON.stringify([path, agent ?? null, mode, theme]);

// Off screen rather than display:none, and pinned at the size it had: an editor laid out for a zero-size box would lay
// itself out again, and throttle, on the way back.
const lotElement = (): HTMLElement => {
    const existing = document.getElementById(LOT_ID);
    if (existing !== null) {
        return existing;
    }
    const lot = document.createElement(`div`);
    lot.id = LOT_ID;
    lot.setAttribute(`aria-hidden`, `true`);
    lot.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none`;
    document.body.append(lot);
    return lot;
};

const pin = (frame: HTMLIFrameElement): void => {
    const { width, height } = frame.getBoundingClientRect();
    frame.style.width = `${Math.max(1, Math.round(width))}px`;
    frame.style.height = `${Math.max(1, Math.round(height))}px`;
};

const unpin = (frame: HTMLIFrameElement): void => {
    frame.style.width = `100%`;
    frame.style.height = `100%`;
};

// Ends the editor kept under `id`: the frame leaves the page, its socket closes, and the document server saves what
// the session still held, as it would have when the viewer went.
export const drop = (id: string): void => {
    const found = parked.value.get(id);
    if (found === undefined) {
        return;
    }
    clearTimeout(found.timer);
    parked.value.delete(id);
    found.frame.remove();
};

const move = (target: Element, frame: HTMLIFrameElement): boolean => {
    try {
        (target as Movable).moveBefore(frame, null);
        return true;
    } catch {
        // allow(silent-catch): a frame that cannot be moved whole is one to let go; the caller removes it or never kept it.
        return false;
    }
};

// Keeps `kept` under `id`, in place of any older editor of the same document, and answers whether it did. A frame that
// cannot be kept (no `moveBefore`, or already off the page) is the caller's to remove.
export const keep = (id: string, kept: KeptFrame): boolean => {
    if (!canKeep() || !kept.frame.isConnected) {
        return false;
    }
    pin(kept.frame);
    if (!move(lotElement(), kept.frame)) {
        unpin(kept.frame);
        return false;
    }
    drop(id);
    parked.value.set(id, { ...kept, timer: setTimeout(() => drop(id), KEEP_MS) });
    for (const oldest of parked.value.keys()) {
        if (parked.value.size <= MAX_KEPT) {
            break;
        }
        drop(oldest);
    }
    return true;
};

// Moves the editor kept under `id` into `slot` and hands it over; undefined when none is kept.
export const take = (id: string, slot: Element): KeptFrame | undefined => {
    const found = parked.value.get(id);
    if (found === undefined) {
        return undefined;
    }
    clearTimeout(found.timer);
    parked.value.delete(id);
    if (!move(slot, found.frame)) {
        found.frame.remove();
        return undefined;
    }
    unpin(found.frame);
    return { frame: found.frame, session: found.session };
};
