<script setup lang="ts">
import { AnchoredOverlay, Button, explorerColorClass, iconForEntry, type Side } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { type FilePeek, peekLead, peekLines, peekOmitted } from "../drafts/filePeek";
import ChatImageThumb from "./ChatImageThumb.vue";
import { useChatSurface } from "../tools/chatToolSurface";

/* One attached file, at three depths: the tile says what it is (glyph, name, size, its own first lines), hovering it reads the head and the tail. */

const {
    name,
    path,
    peek,
    previewUrl,
    lead = 0,
    progress,
    error,
    framed = false,
    removable = false,
    inert = false,
} = defineProps<{
    name: string;
    // Workspace-relative path: what a click opens, and what `peek` was read from.
    path: string;
    // Head and tail windows, undefined while they are in flight and on a surface that can't read them.
    peek?: FilePeek;
    // A picture's thumbnail, which stands in for the glyph and carries its own hover zoom.
    previewUrl?: string;
    // How many of the file's first lines the tile draws itself. 0 in a tight row (the composer), 3 in a transcript.
    lead?: number;
    // Upload in flight: 0..1. Undefined once the bytes are on disk.
    progress?: number;
    error?: string;
    // Composer only: a bordered token, since chips in a row over the input have to read as discrete removable things.
    framed?: boolean;
    removable?: boolean;
    // Drawn, never operated: a copy inside another hover card, which the pointer passes straight through.
    inert?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();

const surface = useChatSurface();
// Nothing to open while the bytes are still going up, and nothing at all on a page with no workspace behind it.
const openable = computed(() => !inert && surface.openFile !== undefined && progress === undefined);

const icon = computed(() => iconForEntry(name, `file`));
// Fixed `colorful`: the explorer's setting is about the file tree's own density, and a chip in a conversation is not
// that tree. The vocabulary it defines — which hue means a config, a log, an archive — is worth sharing regardless.
const iconColor = computed(() => explorerColorClass(`colorful`, name, `file`, false));

// Middle ellipsis: what tells one attachment from the next is usually a timestamp or a hash at the END, which is
// exactly what a trailing `truncate` eats. The tail rides along at fixed width while the head does the truncating.
const TAIL_CHARS = 9;
const split = computed(() => (name.length > TAIL_CHARS + 6 ? TAIL_CHARS : 0));
const nameHead = computed(() => (split.value === 0 ? name : name.slice(0, -split.value)));
const nameTail = computed(() => (split.value === 0 ? `` : name.slice(-split.value)));

// Whether the head is actually cut, which only the box can answer. `text-overflow: ellipsis` is not used to answer it:
// it keeps the space the last fitting character could not use INSIDE the clipping box, and that space lands between
// the mark and the ending — a word-sized gap in the middle of a filename. The mark rides on the ending instead.
const nameBox = ref<HTMLElement>();
const clipped = ref(false);
watch(
    nameBox,
    (element, _previous, onCleanup) => {
        clipped.value = false;
        if (element === undefined) {
            return;
        }
        const sync = (): void => {
            clipped.value = Math.round(element.scrollWidth) > Math.round(element.clientWidth);
        };
        const observer = new ResizeObserver(sync);
        observer.observe(element);
        sync();
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);

// Scale, and length where length is knowable: the facts a filename withholds. Never the kind, which is the name's own
// ending — the one part of it the middle-ellipsis above never gives up.
const meta = computed(() => {
    if (peek?.present !== true) {
        return ``;
    }
    const bits = [formatBytes(peek.size)];
    const lines = peekLines(peek);
    if (lines !== undefined) {
        bits.push(`${lines.toLocaleString()} ${lines === 1 ? `line` : `lines`}`);
    }
    return bits.join(` · `);
});

const leadLines = computed(() => (lead === 0 || peek === undefined ? [] : peekLead(peek, lead)));

// Whether the drawn lines stop short of the file, which is what the face's bottom fade claims. A file whose every line
// fits ends on a hard edge instead, so the fade never says "there is more" of a file there is no more of.
const truncated = computed(() => peek !== undefined && (peek.headBytes < peek.size || peekLead(peek, lead + 1).length > lead));

// The composer's token wears its own border; everywhere else only the file's text is boxed, and the tile is bare. One
// width for both: a name is what the reader matches against, and it is the first thing a narrower box eats.
const frame = computed(() =>
    framed ? `max-w-72 overflow-hidden rounded-lg border bg-card ${error === undefined ? `border-line` : `border-danger`}` : `max-w-72`,
);

// What the card says when there is no text for it to say anything with.
const nothingToShow = computed(() => {
    if (peek === undefined) {
        // Unreachable while `peeking` gates on the windows having landed; kept so the card can never draw a blank body.
        return `Reading the file…`;
    }
    if (!peek.present) {
        return `This file is no longer in the workspace.`;
    }
    if (peek.binary) {
        return `Not text: nothing to preview here.`;
    }
    return peek.head === `` ? `This file is empty.` : undefined;
});

const omitted = computed(() => (peek === undefined ? 0 : peekOmitted(peek)));

const root = ref<HTMLElement>();
const hovering = ref(false);
// Opens only once there is something to draw, and opens by itself if the windows land while the pointer is still on
// the chip. Writable, so the overlay's own dismissals (Escape, a press outside) can shut it.
const peeking = computed({
    get: () => hovering.value && peek !== undefined,
    set: (value: boolean) => {
        hovering.value = value;
    },
});

// Which side the card hangs off, measured when it opens rather than fixed: placeAnchored flips a side only for its
// opposite, so a card asking for `left` in a window with room on neither side is placed at a negative x and cut off
// by the window edge. Beside the chip where there is room for the card's own width, under it where there isn't.
const GAP = 10;
// Matches the `w-[min(34rem,80vw)]` the template draws the card at; a side chosen against a different number would be
// chosen for a card that isn't this one.
const CARD_PX = 544;
const side = ref<Side>(`left`);
const chooseSide = (): void => {
    const view = root.value?.ownerDocument.defaultView;
    const rect = root.value?.getBoundingClientRect();
    if (view === null || view === undefined || rect === undefined) {
        return;
    }
    side.value = rect.left - GAP * 2 >= CARD_PX ? `left` : view.innerWidth - rect.right - GAP * 2 >= CARD_PX ? `right` : `bottom`;
};

// Opening waits, so a pointer crossing a row of chips doesn't flash a card per chip; closing waits, so the pointer
// can cross the gap onto the card without the card fleeing.
const OPEN_MS = 220;
const CLOSE_MS = 160;
let timer: ReturnType<typeof setTimeout> | undefined;
const settle = (open: boolean, delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
        if (open) {
            chooseSide();
        }
        hovering.value = open;
    }, delay);
};

// Mouse only: a touch "hover" is the first half of a tap, and that tap already opens the file itself.
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        settle(true, OPEN_MS);
    }
};
const onLeave = (): void => settle(false, CLOSE_MS);
// The pointer reaching the card cancels the leave the chip just scheduled.
const onCardEnter = (): void => clearTimeout(timer);
// Keyboard focus is deliberate in a way a passing pointer isn't, so it needs no delay either way.
const onFocus = (): void => {
    clearTimeout(timer);
    chooseSide();
    hovering.value = true;
};
const onBlur = (): void => {
    clearTimeout(timer);
    hovering.value = false;
};

const open = (): void => {
    clearTimeout(timer);
    hovering.value = false;
    surface.openFile?.(path);
};

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
    <div ref="root" class="group relative flex" :class="frame" @pointerenter="onEnter" @pointerleave="onLeave">
<!-- The target, drawn only on approach. -->
        <div
            v-if="!framed && openable"
            class="pointer-events-none absolute -inset-1.5 rounded-lg bg-overlay/50 opacity-0 transition-opacity group-hover:opacity-100"
        ></div>
        <component
            :is="openable ? `button` : `div`"
            :type="openable ? `button` : undefined"
            class="relative flex min-w-0 flex-1 flex-col gap-1 text-left"
            :class="[framed ? `px-2 py-1.5` : ``, openable ? `cursor-pointer` : ``]"
            :aria-label="openable ? `Open ${name} in the workspace` : undefined"
            @click="openable && open()"
            @focus="onFocus"
            @blur="onBlur"
        >
            <!-- Caption, not a header bar: one line of naming that sits on the transcript the way the sent-time does. -->
            <span class="flex min-w-0 items-center gap-1.5">
                <!-- A picture stands in for its own glyph; everything else gets its category's. -->
                <ChatImageThumb v-if="previewUrl" :src="previewUrl" :alt="name" size="h-8 w-8" />
                <Icon v-else :name="icon" class="shrink-0 text-xs" :class="iconColor" />
<!-- Preserve the capture identifier at narrow widths. -->
                <span class="flex min-w-0 items-center text-xs text-content">
                    <!-- Softened at the cut, so a half-drawn glyph reads as the name running into its mark. -->
                    <span
                        ref="nameBox"
                        class="overflow-hidden whitespace-nowrap"
                        :class="clipped ? `[mask-image:linear-gradient(to_right,#000_calc(100%_-_0.6em),transparent)]` : ``"
                        >{{ nameHead }}</span
                    >
                    <span v-if="nameTail" class="shrink-0">{{ clipped ? `…` : `` }}{{ nameTail }}</span>
                </span>
                <span v-if="meta" class="shrink-0 text-2xs whitespace-nowrap text-subtle">· {{ meta }}</span>
                <Icon v-if="progress !== undefined" name="spinner" spin class="shrink-0 text-2xs text-link" />
                <Icon v-else-if="error !== undefined" name="exclamation-circle" class="shrink-0 text-2xs text-danger" v-tooltip.top="error" />
            </span>
<!-- The text equivalent of a thumbnail, and framed for the same reason the screenshot is: this is the file itself, not a label for it. -->
            <span v-if="leadLines.length" class="block overflow-hidden rounded-md border border-line bg-canvas/40 px-2 py-1">
                <!-- The fade masks the LINES, never the box: masking the box would dissolve its border mid-curve. -->
                <span class="flex flex-col" :class="truncated ? `mask-b-from-70%` : ``">
                    <span v-for="(line, index) in leadLines" :key="index" class="truncate font-mono text-2xs leading-snug text-subtle">{{
                        line
                    }}</span>
                </span>
            </span>
        </component>
        <!-- `self-center`: a chip carrying a thumbnail is taller than its text, and only a removable chip — the composer's, which draws no lead lines — is ever asked to sit beside one. -->
        <button
            v-if="removable"
            type="button"
            class="composer-ghost relative m-1 h-5 w-5 shrink-0 self-center"
            aria-label="Remove attachment"
            @click="emit(`remove`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
        <!-- Upload progress: the one thing drawn here that is about the transfer rather than the file. -->
        <div
            v-if="progress !== undefined"
            class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500"
            :style="{ width: `${Math.round(progress * 100)}%` }"
        ></div>

<!-- The peek, teleported out of this chip by the overlay. -->
        <AnchoredOverlay v-model="peeking" :anchor="root" :side="side" cross="start" :gap="GAP">
            <div class="flex max-h-[min(32rem,70vh)] w-[min(34rem,80vw)] flex-col" @pointerenter="onCardEnter" @pointerleave="onLeave">
                <div class="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
                    <Icon :name="icon" class="mt-px shrink-0 text-xs" :class="iconColor" />
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-xs font-medium text-content">{{ name }}</p>
                        <p class="truncate font-mono text-2xs text-subtle">{{ path }}</p>
                    </div>
                    <span v-if="meta" class="shrink-0 text-2xs whitespace-nowrap text-muted">{{ meta }}</span>
                </div>
                <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
                    <p v-if="nothingToShow" class="text-2xs text-subtle">{{ nothingToShow }}</p>
                    <template v-else>
                        <pre class="font-mono text-2xs leading-relaxed whitespace-pre text-muted">{{ peek?.head }}</pre>
                        <!-- Never a bare gap: the reader has to know the two halves aren't continuous. -->
                        <p v-if="omitted > 0" class="my-2 flex items-center gap-2 text-2xs whitespace-nowrap text-subtle">
                            <span class="h-px flex-1 bg-line"></span>
                            {{ formatBytes(omitted) }} not shown
                            <span class="h-px flex-1 bg-line"></span>
                        </p>
                        <pre v-if="peek?.tail" class="font-mono text-2xs leading-relaxed whitespace-pre text-muted">{{ peek.tail }}</pre>
                    </template>
                </div>
                <div v-if="openable" class="shrink-0 border-t border-line px-3 py-1">
                    <Button type="button" size="small" :text="true" class="w-full" @click="open">
                        <Icon name="external-link" />
                        Open in the workspace
                    </Button>
                </div>
            </div>
        </AnchoredOverlay>
    </div>
</template>
