import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref, shallowRef } from "vue";
import { floatChatAt } from "../../features/chat/panel/chatPanelLayout";
import { useNotifications } from "../../workbench/notifications/notifications";
import type { ScreenPoint } from "../../workbench/window/floating";

// THE CHAT TILE, DRAGGED OFF THE RAIL. A third way to the pop-out F9 and the tile's right-click already offer: let go
// anywhere outside the rail and the chat opens in a window of its own, at the place it was let go, the way a browser tab
// torn off its strip becomes a window where it lands. Let go over the rail, or press Escape, and nothing happens.
// Pointer Events rather than HTML5 drag-and-drop, as the board's card drag (useAgentDrag): a ghost of our own drawing,
// Escape to cancel, and no browser picture of a link being carried. Mouse and pen only; a touch on the rail scrolls it.

// Far enough that a click with a shaky hand still opens the chat.
const DRAG_THRESHOLD_PX = 5;

/**
 * Where the pointer holds the window it carries, from that window's top-left: on its title bar, by the chat glyph. The
 * layer draws the outline this far up and left of the pointer, and the window opens the same distance from where the
 * pointer let go, so it lands where its outline was.
 */
export const GRAB = { x: 16, y: 14 } as const;

/**
 * - `pressed`: the button is down on the tile and has not travelled yet; a release here is the tile's own click.
 * - `rail`: carried, over the rail; a release puts it back.
 * - `out`: carried, anywhere outside the rail, past the window's edge included; a release opens the window.
 */
export type ChatDragPhase = `idle` | `pressed` | `rail` | `out`;

interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** Whether a point is over the rail; anywhere else, beyond the window's own edges too, is somewhere to open it. */
export const overRail = (x: number, y: number, rail: Box | undefined): boolean =>
    rail !== undefined && x >= rail.left && x < rail.right && y >= rail.top && y < rail.bottom;

/** Where the window's top-left goes for a release at this screen point: the grab, undone. */
export const dropPoint = (screenX: number, screenY: number): ScreenPoint => ({ left: screenX - GRAB.x, top: screenY - GRAB.y });

/**
 * The drop itself: the chat into its own window, at `at`. A browser holds a window back once the press that asked for
 * it is a few seconds old, which a slow drag can be; then a receipt offers the same window from a press of its own.
 */
export const popChatOutAt = (at: ScreenPoint): void => {
    if (floatChatAt(at)) {
        return;
    }
    useNotifications().report({
        tone: `problem`,
        title: t(`shell.shellDesktop.chatWindowBlocked`),
        detail: t(`shell.shellDesktop.chatWindowBlockedDetail`),
        actions: [{ label: t(`shell.shellDesktop.openChatWindow`), severity: `primary`, run: () => void floatChatAt(at) }],
    });
};

export interface ChatTileDragOptions {
    /** The rail's box now; read at the press, since the rail does not move under a held pointer. */
    readonly rail: () => Box | undefined;
    /** What a release outside the rail does. */
    readonly drop: (at: ScreenPoint) => void;
}

export function useChatTileDrag({ rail, drop }: ChatTileDragOptions) {
    const phase = ref<ChatDragPhase>(`idle`);
    // Viewport pixels, for the layer to draw at.
    const pointer = ref({ x: 0, y: 0 });
    const railBox = shallowRef<Box | undefined>(undefined);
    const dragging = computed(() => phase.value === `rail` || phase.value === `out`);

    let origin = { x: 0, y: 0 };
    // Whether this press ever became a drag: its release must not land as the tile's click, even after an Escape.
    let carried = false;
    let gesture: AbortController | undefined;

    const end = (): void => {
        gesture?.abort();
        gesture = undefined;
        phase.value = `idle`;
    };

    // A drag's release also lands as a click (on the tile, or wherever it and the release share an ancestor), and the
    // tile is a link to /chat. Taken in the capture phase, before the router's own listener sees it; dropped once this
    // task is over, since the click, if one comes, is dispatched in the same one as the release.
    const swallowClick = (): void => {
        const swallow = (event: MouseEvent): void => {
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener(`click`, swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener(`click`, swallow, { capture: true }), 0);
    };

    const onMove = (event: PointerEvent): void => {
        // Cancelled with Escape: still held, waiting for the release to swallow it.
        if (phase.value === `idle`) {
            return;
        }
        if (phase.value === `pressed` && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) {
            return;
        }
        carried = true;
        // Without this a press-and-drag paints a text selection across whatever it passes.
        event.preventDefault();
        pointer.value = { x: event.clientX, y: event.clientY };
        phase.value = overRail(event.clientX, event.clientY, railBox.value) ? `rail` : `out`;
    };

    const onUp = (event: PointerEvent): void => {
        const released = phase.value === `out` && overRail(event.clientX, event.clientY, railBox.value) === false;
        if (carried) {
            swallowClick();
        }
        end();
        if (released) {
            drop(dropPoint(event.screenX, event.screenY));
        }
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key !== `Escape` || !dragging.value) {
            return;
        }
        // Only the drag hears it: an Escape meant to put the tile back must not also close whatever is open under it.
        event.preventDefault();
        event.stopPropagation();
        phase.value = `idle`;
    };

    /** Arms a drag on the tile's pointerdown; it becomes one only once the pointer travels, so a click still opens chat. */
    const press = (event: PointerEvent): void => {
        if (event.pointerType === `touch` || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
        }
        end();
        origin = { x: event.clientX, y: event.clientY };
        pointer.value = origin;
        railBox.value = rail();
        carried = false;
        phase.value = `pressed`;
        gesture = new AbortController();
        const { signal } = gesture;
        window.addEventListener(`pointermove`, onMove, { signal });
        window.addEventListener(`pointerup`, onUp, { signal });
        window.addEventListener(`pointercancel`, end, { signal });
        // Away to another window mid-drag: the release may never be heard here, so the drag ends with the focus.
        window.addEventListener(`blur`, end, { signal });
        window.addEventListener(`keydown`, onKey, { signal, capture: true });
    };

    onScopeDispose(end);

    return { phase, dragging, pointer, railBox, press, cancel: end };
}
