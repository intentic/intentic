<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { basename } from "@intentic/ui/path";
import { attachmentPreview } from "../features/chat/drafts/attachmentPreviews";

// Floating card for a truncated session name on hover (the chat tab strip, the Changes panel's origin chips): the
// derived title (sandbox-contract's deriveTitle) is truncated a second time by its column, so this reveals the
// full title and, where the transcript is in hand, the messages it came from. A native title= or v-tooltip won't
// do, both clip long text to one line; this teleports to the overlay target (the pop-out body while popped out,
// else <body>) to escape the trigger's clipping and sizes itself against that window's room. Opens beside the
// anchor, never over/under it, since every surface raising it is a narrow column of stacked rows that a vertical
// card would cover. One card per surface, driven by every anchor via show()/hide(), so a strip of forty tabs
// costs one node.

const { to = `body` } = defineProps<{
    // Where the card mounts, escaping the trigger's clipping: the pop-out body while popped out, else <body>.
    to?: HTMLElement | "body";
}>();

// One user message as the card draws it: words, pictures, an optional eyebrow saying which message this is. A
// list, not one body string, since a hover answers both "what did I ask for" and "what did I ask for last".
// Attachments are unresolved paths (bytes may still be in flight); resolving `src` here rather than in the caller
// means a picture appears the moment it lands, not on a second hover.
interface HoverCardMessage {
    readonly label?: string;
    readonly text?: string;
    readonly attachments?: readonly string[];
}

// What one anchor reveals: `label` (a muted eyebrow), `title` (the full derived title), `messages` (what it came
// from, when known). `note` is the session's state right now rather than its identity (e.g. "Running · turn 2 ·
// editing ReviewPanel.vue · 2m"); it sits between title and messages since it qualifies the title, not replaces
// it.
interface HoverCardContent {
    readonly label?: string;
    readonly title?: string;
    readonly note?: string;
    readonly messages?: readonly HoverCardMessage[];
}

// The card's width is a share of the room beside its anchor, not a fixed number, since a flat 320px showed a
// screenshot as a grey rectangle with half the window free beside it. SHARE keeps it a peek rather than edge to
// edge; MIN is the width it always had (and the floor below which opening beside the anchor isn't worth it); MAX
// keeps it a preview on a wide monitor. These four are the only statement of the size: the template binds
// `maxWidth` from the placement computed below rather than repeating a number as a class, since a mismatch would
// place the card for a size it isn't drawn at. `maxWidth`, not `width`, since the room is a ceiling and short
// content should still draw a small card.
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const SHARE = 0.8;
const GAP = 8;

const widthIn = (room: number): number => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, room * SHARE)));

const placement = ref<{ content: HoverCardContent; left: number; width: number; top?: number; bottom?: number; maxHeight: number }>();

// An anchor can be removed while the card is up without ever firing `mouseleave` (Chromium fires enter on the
// replacement, never leave on the removed element), so the surface's own `@mouseleave` never runs. The card
// instead holds the element it opened for and drops itself once that element leaves the document, checked on the
// pointer's next move. The listener lives only while a card is up (same discipline as ui/lib/tooltip.ts's
// scroll/resize teardown), so an idle app pays nothing.
let anchor: HTMLElement | undefined;
const dropIfAnchorGone = (): void => {
    if (anchor?.isConnected !== false) {
        return;
    }
    hide();
};
const release = (): void => {
    anchor?.ownerDocument.removeEventListener(`pointermove`, dropIfAnchorGone);
    anchor = undefined;
};
// Takes over as the card's anchor, releasing whatever held it before. Re-arming on the same document is a no-op;
// handing over to the floating window's document means the old one would otherwise keep a stale listener.
const adopt = (el: HTMLElement): void => {
    release();
    anchor = el;
    el.ownerDocument.addEventListener(`pointermove`, dropIfAnchorGone);
};

// Whether there's anything to put under the title; an attachment counts before its bytes arrive, since declining
// to open would make the card depend on a fetch the user can't see.
const says = (message: HoverCardMessage): boolean => (message.text ?? ``).trim() !== `` || (message.attachments?.length ?? 0) > 0;

const show = (event: MouseEvent, content: HoverCardContent): void => {
    if ((content.title ?? ``).trim() === `` && !(content.messages ?? []).some(says)) {
        return;
    } // nothing to reveal
    const el = event.currentTarget as HTMLElement;
    adopt(el);
    // The anchor may live in the floating window, whose viewport is its own; measure and clamp against that window,
    // not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    // Right first, since every surface here has the app's wide area to its right; left mirrors it for a panel docked
    // to the window's right edge. Each side is measured, not just tested against MIN, since the room found also sizes
    // the card, not just places it.
    const roomRight = win.innerWidth - rect.right - GAP * 2;
    const roomLeft = rect.left - GAP * 2;
    const room = roomRight >= MIN_WIDTH ? roomRight : roomLeft >= MIN_WIDTH ? roomLeft : undefined;
    if (room === undefined) {
        // No room on either side: falls back to over/under the anchor, whichever has more room, so the card is at least
        // on screen. No share to take here; the window itself is the constraint.
        const width = Math.min(MAX_WIDTH, win.innerWidth - GAP * 2);
        const left = Math.min(Math.max(GAP, rect.left), win.innerWidth - width - GAP);
        const over = rect.top >= win.innerHeight - rect.bottom;
        const maxHeight = (over ? rect.top : win.innerHeight - rect.bottom) - GAP * 2;
        placement.value = {
            content,
            left,
            width,
            maxHeight,
            ...(over ? { bottom: win.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
        };
        return;
    }
    // Beside the anchor, the card hangs from whichever edge (top or bottom) has the larger room below/above it,
    // needing no measurement of its own unrendered height. It may not grow past that edge though: text clamps to a
    // fixed number of lines, but an image is as tall as the screenshot was, and nothing can scroll a card the pointer
    // passes straight through, so the corner it hangs from also caps how far it may reach.
    const width = widthIn(room);
    const left = room === roomRight ? rect.right + GAP : rect.left - GAP - width;
    const below = win.innerHeight - rect.top >= rect.bottom;
    const maxHeight = below ? win.innerHeight - Math.max(GAP, rect.top) - GAP : Math.min(rect.bottom, win.innerHeight - GAP) - GAP;
    placement.value = {
        content,
        left,
        width,
        maxHeight,
        ...(below ? { top: Math.max(GAP, rect.top) } : { bottom: Math.max(GAP, win.innerHeight - rect.bottom) }),
    };
};
const hide = (): void => {
    release();
    placement.value = undefined;
};

// A card outliving its owner's unmount would keep a listener on a document neither is on anymore.
onBeforeUnmount(hide);

// Messages with something left to say, pictures resolved from the same source pair the sent bubble uses (a
// send-time object URL, or workspace bytes for a restored transcript), so the hover and the chat show the same
// picture. A message whose words merely repeat the title drops just its text; a picture it also carried still
// shows. Non-images resolve to nothing and aren't drawn.
const messages = computed(() => {
    const content = placement.value?.content;
    if (content === undefined) {
        return [];
    }
    const title = content.title?.trim();
    return (content.messages ?? [])
        .map((message) => {
            const text = message.text?.trim();
            return {
                label: message.label,
                text: text === undefined || text === `` || text === title ? undefined : text,
                images: (message.attachments ?? [])
                    .map((path) => ({ src: attachmentPreview(path), alt: basename(path) }))
                    .filter((image): image is { src: string; alt: string } => image.src !== undefined),
            };
        })
        .filter((message) => message.text !== undefined || message.images.length > 0);
});

defineExpose({ show, hide });
</script>

<template>
    <!-- pointer-events-none so the card never eats the hover that summons it. -->
    <Teleport :to="to">
        <!--
            `overflow-hidden` both caps the content to the placement's height and lets full-bleed pictures sit flush
            against
            the rounded corners. A flex column shares that height: the words are `shrink-0` and keep every line, and
            the
            picture takes whatever is left, instead of a computed height clipped by the edge above.
        -->
        <div
            v-if="placement"
            class="pointer-events-none fixed z-50 flex min-w-[12rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-card px-3 py-2 shadow-lg"
            :style="{
                maxWidth: `${placement.width}px`,
                maxHeight: `${placement.maxHeight}px`,
                left: `${placement.left}px`,
                ...(placement.top !== undefined ? { top: `${placement.top}px` } : {}),
                ...(placement.bottom !== undefined ? { bottom: `${placement.bottom}px` } : {}),
            }"
        >
            <p v-if="placement.content.label" class="shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ placement.content.label }}</p>
            <p v-if="placement.content.title" class="shrink-0 break-words whitespace-pre-wrap text-xs font-medium leading-relaxed text-content">
                {{ placement.content.title }}
            </p>
            <!-- Accented, because it is the only line here that can be out of date a second from now. -->
            <p v-if="placement.content.note" class="shrink-0 break-words text-2xs leading-relaxed text-link">{{ placement.content.note }}</p>
            <div
                v-for="(message, index) in messages"
                :key="index"
                class="flex min-h-0 flex-col"
                :class="index > 0 || placement.content.title || placement.content.label ? 'mt-3' : ''"
            >
                <!-- Which end of the conversation this is, when there is more than one end on the card. -->
                <p v-if="message.label" class="shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ message.label }}</p>
                <p v-if="message.text" class="line-clamp-[8] shrink-0 break-words whitespace-pre-wrap text-xs leading-relaxed text-muted">
                    {{ message.text }}
                </p>
                <!--
                    Full-bleed, out through the card's own padding, since an inset picture in an already-narrow card is
                    a thumbnail
                    of a thumbnail. Whole, never cropped: a screenshot (unlike prose) puts nothing important at a fixed
                    position, so
                    cropping to a ceiling could cut the one part that identifies it; contained instead, so recognition
                    gets a
                    smaller whole picture. `min-h-0` lets it yield to the words in a short card; without it a replaced
                    element
                    refuses to shrink and gets clipped by the card's edge.
                -->
                <div
                    v-if="message.images.length > 0"
                    class="-mx-3 flex min-h-0 flex-col gap-px"
                    :class="message.text || message.label ? 'mt-1.5' : ''"
                >
                    <img v-for="image in message.images" :key="image.src" :src="image.src" :alt="image.alt" class="min-h-0 w-full object-contain" />
                </div>
            </div>
        </div>
    </Teleport>
</template>
