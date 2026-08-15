<script setup lang="ts">
import { computed, ref } from "vue";
import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import type { ChatAttachment } from "../composables/chat/transcript";

/* The floating card a truncated name gets on hover — one component for every surface that shows an agentic
 * session under a width it doesn't fit in: the chat tab strip and the Changes panel's origin chips today.
 *
 * It exists because those names are DERIVED (sandbox-contract's deriveTitle) and then truncated a SECOND time
 * by whatever column they land in, so "Right-click on empty s…" is all the user ever sees of a title that is
 * itself already a précis. The card reveals the full derived title, plus the messages it was derived from
 * where the transcript is in hand.
 *
 * A native title= or PrimeVue's v-tooltip would not do: both clip long text to one terse line, which is the
 * exact failure being fixed. So this teleports to the overlay target (the pop-out body while the chat is popped
 * out, else <body>) to escape its trigger's overflow clipping, and places itself with the room in THAT window.
 *
 * It opens BESIDE its anchor, never over/under it. Every surface that raises this card is a narrow column of
 * stacked rows — the chat tab rail down a pop-out window's left edge, the Changes panel's origin chips above
 * its file list — so a card above or below the anchor lands on the very rows the user is reading past. Beside
 * it, the card spills into the wide area next door (the transcript, the editor) and the column stays legible.
 *
 * Trigger side: ONE card per surface, driven by every anchor on it — mouseenter calls show(event, content),
 * mouseleave calls hide(). The card owns the placement, so a strip of forty tabs costs one node, not forty. */

const { to = `body` } = defineProps<{
    // Where the card mounts, escaping the trigger's clipping — the pop-out body while popped out, else <body>.
    to?: HTMLElement | "body";
}>();

/* ONE OF THE USER'S OWN MESSAGES, as the card draws it: the words, the pictures that came with them, and an
 * optional eyebrow saying which message this is. A LIST of these rather than one `body` string because the
 * question a hover answers about a long-running session is "what did I ask for, and what did I ask for last" —
 * two ends that a single blob cannot state (see the caller for why those two).
 *
 * The attachments are the message's own, unresolved: a path's bytes may still be in flight when the card opens
 * (attachmentPreviews retries past a booting daemon), so the src is derived below rather than by the caller,
 * and the picture appears the moment it lands instead of on the second hover. */
interface HoverCardMessage {
    readonly label?: string;
    readonly text?: string;
    readonly attachments?: readonly ChatAttachment[];
}

// What one anchor reveals. `label` is the muted eyebrow ("Landed by"), `title` the full derived title,
// `messages` the fuller thing it came from when the surface has the transcript in hand.
//
// `note` is the one line about the session's state RIGHT NOW rather than its identity — what a glanceable mark
// on the anchor stands for, spelled out ("Running · turn 2 · editing ReviewPanel.vue · 2m"). It sits between
// the title and the messages because it qualifies the title: it is the difference between "this is what that
// session was for" and "and it is still doing it".
interface HoverCardContent {
    readonly label?: string;
    readonly title?: string;
    readonly note?: string;
    readonly messages?: readonly HoverCardMessage[];
}

/* THE CARD'S WIDTH IS THE ROOM IT HAS, not a number. It was a flat 320px, which is the width of the narrow
 * column it opens NEXT TO — and next to that column is the widest empty area on the screen. So a hover over a
 * chat whose prompt was a screenshot drew that screenshot into a 320px slot with half the window free beside
 * it, at which size a screenshot is a grey rectangle: the one thing pictures were put on this card to do,
 * undone by the width.
 *
 * A SHARE of the room rather than all of it — the card is a thing that has appeared over the top of something,
 * and one that runs edge to edge reads as a page rather than a peek. MIN is the width it always had, and also
 * the width below which opening beside the anchor isn't worth doing (see the placement). MAX is what keeps a
 * preview a preview on a wide monitor, where four fifths of the room would be most of the desk.
 *
 * These are the ONLY statement of the size: the template binds `maxWidth` from the placement rather than
 * repeating a number as a utility class. Two spellings of one width is how a card ends up placed for a size it
 * isn't drawn at — the placement measures the room against MIN to choose a side and then hands the width back
 * out, so a class disagreeing with it would put the card off the edge it just checked.
 *
 * `maxWidth`, not `width`: the room is a ceiling, and short content should still draw a small card. What
 * actually reaches for the ceiling is a long prompt and, above all, a picture — an image's own width is far
 * past any of these, so a card carrying one always takes the whole of what it was allowed. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const SHARE = 0.8;
const GAP = 8;

const widthIn = (room: number): number => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, room * SHARE)));

/* How tall a picture may be, given the width it is being drawn at. It used to be a flat 16rem, which grew
 * WRONG as the card grew: `object-cover` crops whatever the box won't take, so a fixed ceiling over a widening
 * card means an ever harder crop — the opposite of what more room is for. So it is a shape (a 4:3 window on the
 * picture) bounded by a share of the card's own height allowance, which is what keeps a tall screenshot from
 * pushing the words that explain it out of the bottom of the card. */
const imageHeightIn = (width: number, maxHeight: number): number => Math.round(Math.min(width * 0.75, maxHeight * 0.45));

const placement = ref<{ content: HoverCardContent; left: number; width: number; top?: number; bottom?: number; maxHeight: number }>();

// Anything at all to put under the title. An attachment counts before its bytes arrive: it is a picture the card
// is about to draw, and declining to open on it would make the card depend on a fetch the user can't see.
const says = (message: HoverCardMessage): boolean => (message.text ?? ``).trim() !== `` || (message.attachments?.length ?? 0) > 0;

const show = (event: MouseEvent, content: HoverCardContent): void => {
    if ((content.title ?? ``).trim() === `` && !(content.messages ?? []).some(says)) return; // nothing to reveal
    const el = event.currentTarget as HTMLElement;
    // The anchor may live in the pop-out window, whose viewport (and fixed-position origin) is its own — measure
    // and clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    /* Right first — every surface here is a column with the app's wide area on its right. Left is the mirror
     * for an anchor in a panel docked to the window's right edge (the docked chat's tab strip). Each side is
     * measured, not tested against one number, because the room is now what the card is SIZED from as well as
     * where it goes: a side qualifies at MIN and the card then takes its share of whatever it actually found. */
    const roomRight = win.innerWidth - rect.right - GAP * 2;
    const roomLeft = rect.left - GAP * 2;
    const room = roomRight >= MIN_WIDTH ? roomRight : roomLeft >= MIN_WIDTH ? roomLeft : undefined;
    if (room === undefined) {
        // No room either side (a window narrower than the card plus its anchor): fall back to under/over the
        // anchor, whichever has more room, so the card is at least on screen. Nothing to take a share of out
        // here — the window itself is the constraint — so it spends the width it is given.
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
    /* Beside, the card's height is unknown until it renders, so it hangs from the anchor's top while the room
     * below that edge is the larger, and rises from the anchor's bottom otherwise — no measurement needed, and
     * an anchor at either end of a full-height rail still gets a card that fits.
     *
     * What it may NOT do is grow past the edge it was placed against, which pictures made a live risk: text
     * clamps itself to a known number of lines, an image is however tall the user's screenshot was. So the
     * corner the card hangs from also states how far it may reach from there, and the card clips at that —
     * nothing can scroll a card the pointer passes straight through, so the cap has to be a cap. */
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
    placement.value = undefined;
};

/* THE MESSAGES AS DRAWN — the blocks that have something left to say, each with its pictures resolved.
 *
 * A block whose words merely repeat the title is dropped, because a one-line first message IS its own derived
 * title and printing it twice reads as a rendering bug — but only its WORDS go: a message that also carried a
 * screenshot still has a picture to show, so it keeps its block and loses the duplicate line.
 *
 * The src comes from the send-time object URL where this page made one, and from the workspace bytes otherwise
 * (a transcript restored from history) — the same pair of sources the sent bubble draws from, so the picture in
 * the hover and the picture in the chat are the same picture. Non-images resolve to nothing and are simply not
 * drawn: the card is a glance, and a row of file-name chips is not what it is for. */
const messages = computed(() => {
    const content = placement.value?.content;
    if (content === undefined) return [];
    const title = content.title?.trim();
    return (content.messages ?? [])
        .map((message) => {
            const text = message.text?.trim();
            return {
                label: message.label,
                text: text === undefined || text === `` || text === title ? undefined : text,
                images: (message.attachments ?? [])
                    .map((attachment) => ({ src: attachment.previewUrl ?? attachmentPreview(attachment.path), alt: attachment.name }))
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
        <!-- overflow-hidden does two jobs: it holds the content to the height the placement allowed, and it is
             what lets the full-bleed pictures below sit flush against the card's rounded corners. -->
        <div
            v-if="placement"
            class="pointer-events-none fixed z-50 min-w-[12rem] overflow-hidden rounded-lg border border-line-strong bg-card px-3 py-2 shadow-lg"
            :style="{
                maxWidth: `${placement.width}px`,
                maxHeight: `${placement.maxHeight}px`,
                left: `${placement.left}px`,
                ...(placement.top !== undefined ? { top: `${placement.top}px` } : {}),
                ...(placement.bottom !== undefined ? { bottom: `${placement.bottom}px` } : {}),
            }"
        >
            <p v-if="placement.content.label" class="text-2xs uppercase tracking-wide text-subtle">{{ placement.content.label }}</p>
            <p v-if="placement.content.title" class="break-words whitespace-pre-wrap text-xs font-medium leading-relaxed text-content">
                {{ placement.content.title }}
            </p>
            <!-- Accented, because it is the only line here that can be out of date a second from now. -->
            <p v-if="placement.content.note" class="break-words text-2xs leading-relaxed text-link">{{ placement.content.note }}</p>
            <div
                v-for="(message, index) in messages"
                :key="index"
                :class="index > 0 || placement.content.title || placement.content.label ? 'mt-1.5 border-t border-line pt-1.5' : ''"
            >
                <!-- Which end of the conversation this is, when there is more than one end on the card. -->
                <p v-if="message.label" class="text-2xs uppercase tracking-wide text-subtle">{{ message.label }}</p>
                <p v-if="message.text" class="line-clamp-[8] break-words whitespace-pre-wrap text-xs leading-relaxed text-muted">
                    {{ message.text }}
                </p>
                <!-- FULL-BLEED, out through the card's own padding: a picture inset inside a card that is
                     itself a narrow box is a thumbnail of a thumbnail, and the reason to put the picture here
                     at all is that it is the fastest way to recognise which conversation this is. Cropped from
                     the top rather than letterboxed, which is the same bargain the text above it makes — the
                     card shows the start of a long thing, at full width, and stops. -->
                <div v-if="message.images.length > 0" class="-mx-3 flex flex-col gap-px" :class="message.text || message.label ? 'mt-1.5' : ''">
                    <img
                        v-for="image in message.images"
                        :key="image.src"
                        :src="image.src"
                        :alt="image.alt"
                        class="w-full object-cover object-top"
                        :style="{ maxHeight: `${imageHeightIn(placement.width, placement.maxHeight)}px` }"
                    />
                </div>
            </div>
        </div>
    </Teleport>
</template>
