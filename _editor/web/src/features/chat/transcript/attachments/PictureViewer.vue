<script lang="ts">
// One picture the viewer walks: its name for the header, its filmstrip thumb (undefined while it is coming), and the
// group it stands in, a divider in the filmstrip wherever the group changes.
export interface ViewerPicture {
    readonly key: string;
    readonly name: string;
    readonly tile: string | undefined;
    readonly group: string | number;
}
</script>

<script setup lang="ts">
import { Modal, ui } from "@intentic/ui";
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import { useT } from "@intentic/ui/i18n";

// Pictures one at a time and large, over the whole window: the arrows and the keys walk the list, the filmstrip jumps,
// and a press on the picture swaps fit for actual size. The one frame both of the chat's viewers draw, a conversation's
// pictures (ChatShotViewer) and a page's own (ChatPageFrame), so a picture opens the same way wherever it was shown.
// What the stage draws, and what else the header offers (the `actions` slot), are theirs to say.

const t = useT();

const props = defineProps<{
    pictures: readonly ViewerPicture[];
    // The picture the viewer stands at, as the stage draws it: its URL, no URL once it can no longer be had, or
    // undefined while it is coming.
    drawn: { readonly url?: string } | undefined;
    // Said after the picture's place in the list, when there is something to say.
    caption?: string;
    // What the filmstrip holds, for assistive tech.
    filmstrip: string;
}>();

const open = defineModel<boolean>("open", { required: true });
// Where the viewer stands, by key rather than position, so a list that grows doesn't move what is on screen. A key the
// list no longer holds stands at the first.
const at = defineModel<string | undefined>("at", { required: true });

const titleId = useId();
const actual = ref(false);
watch(
    open,
    (opened) => {
        if (opened) {
            actual.value = false;
        }
    },
    { immediate: true },
);

const index = computed(() =>
    Math.max(
        0,
        props.pictures.findIndex((picture) => picture.key === at.value),
    ),
);
const name = computed(() => props.pictures[index.value]?.name ?? ``);

const go = (to: number): void => {
    const next = props.pictures[Math.min(props.pictures.length - 1, Math.max(0, to))];
    if (next !== undefined) {
        at.value = next.key;
    }
};

const onKey = (event: KeyboardEvent): void => {
    const moves = new Map([
        [`ArrowLeft`, index.value - 1],
        [`ArrowRight`, index.value + 1],
        [`Home`, 0],
        [`End`, props.pictures.length - 1],
    ]);
    const to = moves.get(event.key);
    if (to === undefined) {
        return;
    }
    event.preventDefault();
    go(to);
};

// One run of the filmstrip per group, in order.
const groups = computed(() => {
    const out: { group: string | number; items: { picture: ViewerPicture; index: number }[] }[] = [];
    for (const [position, picture] of props.pictures.entries()) {
        const last = out.at(-1);
        if (last?.group === picture.group) {
            last.items.push({ picture, index: position });
        } else {
            out.push({ group: picture.group, items: [{ picture, index: position }] });
        }
    }
    return out;
});

// Takes the keyboard once the box is up, so the arrows move through pictures from the first press.
const root = useTemplateRef<HTMLElement>(`root`);
const strip = useTemplateRef<HTMLElement>(`strip`);

// Keeps the current thumb in view as the arrows walk past the filmstrip's edge.
watch(at, async () => {
    await nextTick();
    strip.value?.querySelector(`[aria-current="true"]`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
});
</script>

<template>
    <Modal v-model:open="open" size="full" :chrome="false" :scroll="false" :labelled-by="titleId" @show="root?.focus()">
        <div ref="root" tabindex="-1" class="flex min-h-0 flex-1 flex-col outline-none" @keydown="onKey">
            <header class="flex items-center gap-2 border-b border-line px-3 py-2">
                <div class="min-w-0 flex-1">
                    <h2 :id="titleId" class="truncate text-xs font-medium text-content">{{ name }}</h2>
                    <p class="truncate text-2xs text-subtle">
                        <span class="tabular-nums">{{ t(`chat.pictureViewer.position`, { index: index + 1, total: pictures.length }) }}</span>
                        <template v-if="caption"> · {{ caption }}</template>
                    </p>
                </div>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-pressed="actual"
                    :aria-label="actual ? t(`chat.pictureViewer.fit`) : t(`chat.pictureViewer.actualSize`)"
                    v-tooltip.bottom="actual ? t(`chat.pictureViewer.fit`) : t(`chat.pictureViewer.actualSize`)"
                    @click="actual = !actual"
                >
                    <Icon :name="actual ? `compress` : `expand`" class="text-xs" />
                </button>
                <slot name="actions" />
                <button type="button" :class="ui.iconButton()" :aria-label="t(`chat.pictureViewer.close`)" @click="open = false">
                    <Icon name="times" class="text-xs" />
                </button>
            </header>

            <!-- The arrows stand on the stage, outside the part that scrolls, so a picture at actual size can't carry them off. -->
            <div class="relative flex min-h-0 flex-1 bg-canvas">
                <!-- Fit centres the picture; actual size lets it overflow from the top-left and scroll. -->
                <div class="flex min-h-0 min-w-0 flex-1" :class="actual ? `overflow-auto` : `items-center justify-center overflow-hidden p-3`">
                    <img
                        v-if="drawn?.url"
                        :src="drawn.url"
                        :alt="name"
                        :class="
                            actual
                                ? `max-w-none shrink-0 cursor-zoom-out self-start`
                                : `max-h-full max-w-full cursor-zoom-in rounded-sm object-contain shadow-sm`
                        "
                        @click="actual = !actual"
                    />
                    <p v-else-if="drawn" class="m-auto flex items-center gap-1.5 text-xs text-subtle">
                        <Icon name="image" class="text-xs" />{{ t(`chat.words.gone`) }}
                    </p>
                    <Icon v-else name="spinner" spin class="m-auto text-subtle" />
                </div>
                <template v-if="pictures.length > 1">
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xl` }, `absolute top-1/2 left-2 -translate-y-1/2 bg-card/80 shadow-sm`)"
                        :disabled="index === 0"
                        :aria-label="t(`chat.pictureViewer.previous`)"
                        @click="go(index - 1)"
                    >
                        <Icon name="arrow-left" class="text-xs" />
                    </button>
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xl` }, `absolute top-1/2 right-2 -translate-y-1/2 bg-card/80 shadow-sm`)"
                        :disabled="index === pictures.length - 1"
                        :aria-label="t(`chat.pictureViewer.next`)"
                        @click="go(index + 1)"
                    >
                        <Icon name="arrow-right" class="text-xs" />
                    </button>
                </template>
            </div>

            <nav v-if="pictures.length > 1" ref="strip" class="flex shrink-0 gap-2 overflow-x-auto border-t border-line px-3 py-2" :aria-label="filmstrip">
                <template v-for="(run, position) in groups" :key="run.group">
                    <span v-if="position > 0" class="w-px shrink-0 self-stretch bg-line" aria-hidden="true" />
                    <div class="flex shrink-0 gap-1">
                        <button
                            v-for="item in run.items"
                            :key="item.picture.key"
                            type="button"
                            class="chat-inset aspect-[16/10] h-12 shrink-0 cursor-pointer overflow-hidden rounded border transition-[border-color,opacity]"
                            :class="item.index === index ? `border-primary-500` : `border-line opacity-60 hover:opacity-100`"
                            :aria-current="item.index === index"
                            :aria-label="t(`chat.pictureViewer.show`, { name: item.picture.name })"
                            @click="go(item.index)"
                        >
                            <img v-if="item.picture.tile" :src="item.picture.tile" alt="" class="h-full w-full object-cover object-top" />
                        </button>
                    </div>
                </template>
            </nav>
        </div>
    </Modal>
</template>
