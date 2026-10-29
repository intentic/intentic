import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref, shallowRef } from "vue";
import type { Router } from "vue-router";
import { dockChatToSide, floatChatAt } from "../../models/conversations/panel/chatPanelLayout";
import { useNotifications } from "../../workbench/notifications/notifications";
import type { ScreenPoint } from "../../workbench/window/floating";
import { useLayout } from "../../workbench/window/useLayout";
import { toScreenPx } from "../../workbench/window/uiScale";

// THE CHAT TILE, DRAGGED OFF THE RAIL. The middle opens a window where the tile was let go; the right edge docks the
// chat beside the current section. Let go over the rail, or press Escape, and nothing happens.
// Pointer Events rather than HTML5 drag-and-drop, as the board's card drag (useAgentDrag): a ghost of our own drawing,
// Escape to cancel, and no browser picture of a link being carried. Mouse and pen only; a touch on the rail scrolls it.

// Far enough that a click with a shaky hand still opens the chat.
const DRAG_THRESHOLD_PX = 5;

/**
 * Where the pointer holds a new window, from its top-left: on its title bar, by the chat glyph.
 */
export const GRAB = { x: 16, y: 14 } as const;

/**
 * - `pressed`: the button is down on the tile and has not travelled yet; a release here is the tile's own click.
 * - `rail`: carried, over the rail; a release puts it back.
 * - `dock`: carried, over the right-side target; a release docks the chat on the right.
 * - `out`: carried, outside both targets, past the window's edge included; a release opens the window.
 */
export type ChatDragPhase = `idle` | `pressed` | `rail` | `out` | `dock`;

interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** The painted targets include their top and left edges, and exclude their bottom and right edges. */
export const containsPoint = (x: number, y: number, box: Box | undefined): boolean =>
    box !== undefined && x >= box.left && x < box.right && y >= box.top && y < box.bottom;

/** Where the window's top-left goes for a release at this screen point: the grab, undone. */
const dropPoint = (screenX: number, screenY: number): ScreenPoint => ({ left: screenX - GRAB.x, top: screenY - GRAB.y });

/**
 * The drop itself: the chat into its own window, at `at`. A browser holds a window back once the press that asked for
 * it is a few seconds old, which a slow drag can be; then a receipt offers the same window from a press of its own.
 */
const popChatOutAt = (at: ScreenPoint): void => {
    if (floatChatAt(at)) {
        return;
    }
    useNotifications().report({
        tone: `problem`,
        title: t(`shell.shellDesktop.chatWindowBlocked`),
        detail: t(`shell.shellDesktop.chatWindowBlockedDetail`),
        actions: [{ label: t(`shell.shellDesktop.openChatWindow`), tier: `accent`, run: () => void floatChatAt(at) }],
    });
};

export interface ChatTileDragOptions {
    /** The rail's box now; read at the press, since the rail does not move under a held pointer. */
    readonly rail: () => Box | undefined;
    /** Width of the docked chat, in viewport pixels. The target leaves at least half the room for a new window. */
    readonly dockWidth: () => number;
    readonly dock: () => void;
    /** What a release outside the rail and the dock target does. */
    readonly drop: (at: ScreenPoint) => void;
}

// A drag's release also lands as a click. Capture it before the tile's router link can navigate to /chat.
const swallowClick = (): void => {
    const swallow = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
    };
    window.addEventListener(`click`, swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener(`click`, swallow, { capture: true }), 0);
};

export function useChatTileDrag({ rail, dockWidth, dock, drop }: ChatTileDragOptions) {
    const phase = ref<ChatDragPhase>(`idle`);
    // Viewport pixels, for the layer to draw at.
    const pointer = ref({ x: 0, y: 0 });
    const railBox = shallowRef<Box | undefined>(undefined);
    const dockBox = shallowRef<Box | undefined>(undefined);
    const dragging = computed(() => phase.value === `rail` || phase.value === `out` || phase.value === `dock`);
    const targetAt = (x: number, y: number): ChatDragPhase => {
        if (containsPoint(x, y, railBox.value)) {
            return `rail`;
        }
        return containsPoint(x, y, dockBox.value) ? `dock` : `out`;
    };

    let origin = { x: 0, y: 0 };
    // Whether this press ever became a drag: its release must not land as the tile's click, even after an Escape.
    let carried = false;
    let gesture: AbortController | undefined;

    const end = (): void => {
        gesture?.abort();
        gesture = undefined;
        phase.value = `idle`;
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
        phase.value = targetAt(event.clientX, event.clientY);
    };

    const onUp = (event: PointerEvent): void => {
        // Use the release's position too: its last move can have been in the other target.
        const target = dragging.value ? targetAt(event.clientX, event.clientY) : undefined;
        if (carried) {
            swallowClick();
        }
        end();
        if (target === `dock`) {
            dock();
        } else if (target === `out`) {
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
        dockBox.value = {
            left: window.innerWidth - Math.min(dockWidth(), (window.innerWidth - (railBox.value?.right ?? 0)) / 2),
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
        };
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

    return { phase, dragging, pointer, railBox, dockBox, press, cancel: end };
}

export const useChatRailDrag = (rail: ChatTileDragOptions[`rail`], router: Router) => {
    const layout = useLayout();
    return useChatTileDrag({
        rail,
        dockWidth: () => toScreenPx(layout.chatWidth.value),
        dock: () => dockChatToSide(router, `right`),
        drop: popChatOutAt,
    });
};
