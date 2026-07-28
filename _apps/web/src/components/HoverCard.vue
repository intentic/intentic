<script setup lang="ts">
import { computed, ref } from "vue";

/* The floating card a truncated name gets on hover — one component for every surface that shows an agentic
 * session under a width it doesn't fit in: the chat tab strip and the Changes panel's origin chips today.
 *
 * It exists because those names are DERIVED (sandbox-contract's deriveTitle) and then truncated a SECOND time
 * by whatever column they land in, so "Right-click on empty s…" is all the user ever sees of a title that is
 * itself already a précis. The card reveals the full derived title, plus the first message it was derived from
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

// What one anchor reveals. `label` is the muted eyebrow ("Landed by"), `title` the full derived title, `body`
// the fuller text it came from (a tab's first message) when the surface has it.
interface HoverCardContent {
    readonly label?: string;
    readonly title?: string;
    readonly body?: string;
}

const WIDTH = 320; // px — matches max-w below.
const GAP = 8;

const placement = ref<{ content: HoverCardContent; left: number; top?: number; bottom?: number }>();

const show = (event: MouseEvent, content: HoverCardContent): void => {
    if ((content.title ?? ``).trim() === `` && (content.body ?? ``).trim() === ``) return; // nothing to reveal
    const el = event.currentTarget as HTMLElement;
    // The anchor may live in the pop-out window, whose viewport (and fixed-position origin) is its own — measure
    // and clamp against that window, not the main realm's globalThis.
    const win = el.ownerDocument.defaultView ?? globalThis;
    const rect = el.getBoundingClientRect();
    // Right first — every surface here is a column with the app's wide area on its right. Left is the mirror
    // for an anchor in a panel docked to the window's right edge (the docked chat's tab strip).
    const beside = rect.right + GAP + WIDTH <= win.innerWidth ? rect.right + GAP : rect.left - GAP - WIDTH >= 0 ? rect.left - GAP - WIDTH : undefined;
    if (beside === undefined) {
        // No room either side (a window narrower than the card plus its anchor): fall back to under/over the
        // anchor, whichever has more room, so the card is at least on screen.
        const left = Math.min(Math.max(GAP, rect.left), win.innerWidth - WIDTH - GAP);
        placement.value =
            rect.top >= win.innerHeight - rect.bottom
                ? { content, left, bottom: win.innerHeight - rect.top + GAP }
                : { content, left, top: rect.bottom + GAP };
        return;
    }
    // Beside, the card's height is unknown until it renders, so it hangs from the anchor's top while the room
    // below that edge is the larger, and rises from the anchor's bottom otherwise — no measurement needed, and
    // an anchor at either end of a full-height rail still gets a card that fits.
    placement.value =
        win.innerHeight - rect.top >= rect.bottom
            ? { content, left: beside, top: Math.max(GAP, rect.top) }
            : { content, left: beside, bottom: Math.max(GAP, win.innerHeight - rect.bottom) };
};
const hide = (): void => {
    placement.value = undefined;
};

// The body only earns its space when it says more than the title already does — a one-line first message IS
// its own derived title, and repeating it reads as a rendering bug.
const body = computed(() => {
    const content = placement.value?.content;
    if (content === undefined) return undefined;
    const text = content.body?.trim();
    return text === undefined || text === `` || text === content.title?.trim() ? undefined : text;
});

defineExpose({ show, hide });
</script>

<template>
    <!-- pointer-events-none so the card never eats the hover that summons it. -->
    <Teleport :to="to">
        <div
            v-if="placement"
            class="pointer-events-none fixed z-50 min-w-[12rem] max-w-[320px] rounded-lg border border-line-strong bg-card px-3 py-2 shadow-2xl"
            :style="{
                left: `${placement.left}px`,
                ...(placement.top !== undefined ? { top: `${placement.top}px` } : {}),
                ...(placement.bottom !== undefined ? { bottom: `${placement.bottom}px` } : {}),
            }"
        >
            <p v-if="placement.content.label" class="text-2xs uppercase tracking-wide text-subtle">{{ placement.content.label }}</p>
            <p v-if="placement.content.title" class="break-words whitespace-pre-wrap text-xs font-medium leading-relaxed text-content">
                {{ placement.content.title }}
            </p>
            <p
                v-if="body"
                class="line-clamp-[12] break-words whitespace-pre-wrap text-xs leading-relaxed text-muted"
                :class="placement.content.title ? 'mt-1 border-t border-line pt-1' : ''"
            >
                {{ body }}
            </p>
        </div>
    </Teleport>
</template>
