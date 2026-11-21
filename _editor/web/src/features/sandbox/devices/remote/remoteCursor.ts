import type { MediaCursor } from "@intentic/sandbox-contract/browser-wire";
import { computed, type ComputedRef, onScopeDispose, ref, type Ref, watch } from "vue";

// THE COMPUTER'S OWN POINTER, DRAWN OVER ITS PICTURE. The picture never has the pointer in it (castd and remoted leave
// it out, and the viewer gives its own cursor the computer's look), so a pointer moved over there by the person at the
// computer, or by an app warping it, was not seen here until the next frame happened to show what it did. castd now says
// where the pointer is as it moves (`pointer`, picture pixels), and the pointer is drawn there whenever it is not this
// viewer's own: while the viewer only watches, or once its own pointer has been still over the stage for a moment (its
// own moves come back as `pointer` too, at the same place, and its own cursor already stands there).

/** How long this viewer's own pointer must be still before the computer's is drawn beside it. */
export const OWN_POINTER_MS = 400;

interface Box {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** Where the computer's pointer is drawn on the stage, in CSS px, and in what look; undefined where it is not drawn. */
export interface Sprite {
    readonly left: number;
    readonly top: number;
    // The computer's cursor image (a PNG data URL) with its hotspot in CSS px, or none for the default arrow.
    readonly image?: { readonly url: string; readonly width: number; readonly hotX: number; readonly hotY: number };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The sprite for `pointer` (picture pixels) on a picture of `size` placed at `box`: the computer's cursor image where it
 * sent one (in picture pixels, as wide as its PNG's header says), else the default arrow; none for a pointer off the
 * picture.
 */
export const spriteAt = (
    pointer: { readonly x: number; readonly y: number },
    size: { readonly width: number; readonly height: number },
    box: Box,
    look: MediaCursor | undefined,
): Sprite | undefined => {
    if (size.width <= 0 || size.height <= 0 || pointer.x < 0 || pointer.y < 0 || pointer.x >= size.width || pointer.y >= size.height) {
        return undefined;
    }
    const left = box.left + (pointer.x * box.width) / size.width;
    const top = box.top + (pointer.y * box.height) / size.height;
    const png = look?.png;
    const width = png === undefined ? 0 : pngWidth(png);
    if (png === undefined || !BASE64.test(png) || width === 0) {
        return { left, top };
    }
    const css = box.width / size.width;
    return {
        left,
        top,
        image: { url: `data:image/png;base64,${png}`, width: width * css, hotX: (look?.hotX ?? 0) * css, hotY: (look?.hotY ?? 0) * css },
    };
};

// A PNG's width, off its IHDR (bytes 16..20 of the file); 0 for anything that is not one.
const pngWidth = (base64: string): number => {
    try {
        const head = atob(base64.slice(0, 32));
        if (head.length < 24 || !head.startsWith(`\u0089PNG`)) {
            return 0;
        }
        return ((head.charCodeAt(16) << 24) | (head.charCodeAt(17) << 16) | (head.charCodeAt(18) << 8) | head.charCodeAt(19)) >>> 0;
    } catch {
        // allow(silent-catch): a header that is not base64 is no image; the arrow stands in for it.
        return 0;
    }
};

export interface RemoteCursorOptions {
    readonly pointer: Ref<{ readonly x: number; readonly y: number } | undefined>;
    readonly look: Ref<MediaCursor | undefined>;
    readonly size: Ref<{ readonly width: number; readonly height: number } | undefined>;
    readonly box: Ref<Box | undefined>;
    // This viewer drives the computer (its pointer is the computer's while it moves).
    readonly driving: Ref<boolean>;
    readonly stage: Ref<HTMLElement | null>;
    // Seams for a test: the clock and the timer the stillness waits on.
    readonly now?: () => number;
    readonly later?: (run: () => void, ms: number) => () => void;
}

const timeout = (run: () => void, ms: number): (() => void) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
};

export const useRemoteCursor = (options: RemoteCursorOptions): ComputedRef<Sprite | undefined> => {
    const later = options.later ?? timeout;
    // This viewer's own pointer moved over the stage lately: the computer's pointer is that one.
    const ownMoving = ref(false);
    let still: (() => void) | undefined;
    const moved = (): void => {
        ownMoving.value = true;
        still?.();
        still = later(() => (ownMoving.value = false), OWN_POINTER_MS);
    };
    const left = (): void => {
        still?.();
        ownMoving.value = false;
    };
    watch(
        options.stage,
        (element, before) => {
            before?.removeEventListener(`pointermove`, moved);
            before?.removeEventListener(`pointerleave`, left);
            element?.addEventListener(`pointermove`, moved);
            element?.addEventListener(`pointerleave`, left);
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        still?.();
        options.stage.value?.removeEventListener(`pointermove`, moved);
        options.stage.value?.removeEventListener(`pointerleave`, left);
    });
    return computed(() => {
        const pointer = options.pointer.value;
        const size = options.size.value;
        const box = options.box.value;
        if (pointer === undefined || size === undefined || box === undefined || (options.driving.value && ownMoving.value)) {
            return undefined;
        }
        return spriteAt(pointer, size, box, options.look.value);
    });
};
