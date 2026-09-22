<script setup lang="ts">
import { Modal, ui } from "@intentic/ui";
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import { useT } from "@intentic/ui/i18n";
import { useChatSurface } from "../../tools/chatToolSurface";
import { type ChatShot, shotName } from "./shots";
import { pictureAt, tileOf } from "./shotPictures";

// The conversation's pictures one at a time and large, opened from a strip's tile or a tool card's picture; the arrows
// walk every turn's strip in order and the filmstrip jumps. Fit to the window, or at actual size for a full-page capture.

const t = useT();

const props = defineProps<{
    shots: readonly ChatShot[];
    // The shot it opens at, by key; a key the list no longer holds opens at the first.
    start: string | undefined;
    // Whose checkout the pictures are read in (shotPictures), undefined for the shared tree.
    agent: string | undefined;
    // What each turn was asked, by turn id, for the caption.
    prompts: ReadonlyMap<number, string>;
}>();

const open = defineModel<boolean>(`open`, { required: true });

const surface = useChatSurface();
const titleId = useId();

// Where the viewer stands, by key rather than position, so a live turn adding pictures doesn't move what is on screen.
const at = ref<string>();
const actual = ref(false);

watch(
    open,
    (opened) => {
        if (opened) {
            at.value = props.start;
            actual.value = false;
        }
    },
    { immediate: true },
);

const index = computed(() => Math.max(0, props.shots.findIndex((shot) => shot.key === at.value)));
const shot = computed<ChatShot | undefined>(() => props.shots[index.value]);
const picture = computed(() => (shot.value === undefined ? undefined : pictureAt(props.agent, shot.value.path)));
const name = computed(() => (shot.value === undefined ? `` : shotName(shot.value.path)));
const fileName = computed(() => shot.value?.path.split(`/`).at(-1) ?? ``);
const prompt = computed(() => (shot.value === undefined ? undefined : props.prompts.get(shot.value.turnId)));

const go = (to: number): void => {
    const next = props.shots[Math.min(props.shots.length - 1, Math.max(0, to))];
    if (next !== undefined) {
        at.value = next.key;
    }
};

const onKey = (event: KeyboardEvent): void => {
    const moves: Partial<Record<string, number>> = {
        ArrowLeft: index.value - 1,
        ArrowRight: index.value + 1,
        Home: 0,
        End: props.shots.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) {
        return;
    }
    event.preventDefault();
    go(to);
};

// One group per turn, in order: a divider between groups is where one turn's pictures end and the next one's begin.
const groups = computed(() => {
    const out: { turnId: number; items: { shot: ChatShot; index: number; tile: ReturnType<typeof tileOf> }[] }[] = [];
    for (const [position, entry] of props.shots.entries()) {
        const item = { shot: entry, index: position, tile: tileOf(props.agent, entry.path) };
        const last = out.at(-1);
        if (last?.turnId === entry.turnId) {
            last.items.push(item);
        } else {
            out.push({ turnId: entry.turnId, items: [item] });
        }
    }
    return out;
});

const openInWorkspace = (): void => {
    const current = shot.value;
    if (current === undefined) {
        return;
    }
    open.value = false;
    surface.openFile?.(current.path);
};

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
                        <span class="tabular-nums">{{ t(`chat.chatShotViewer.position`, { index: index + 1, total: shots.length }) }}</span>
                        <template v-if="prompt"> · {{ prompt }}</template>
                    </p>
                </div>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-pressed="actual"
                    :aria-label="actual ? t(`chat.chatShotViewer.fitToWindow`) : t(`chat.chatShotViewer.actualSize`)"
                    v-tooltip.bottom="actual ? t(`chat.chatShotViewer.fitToWindow`) : t(`chat.chatShotViewer.actualSize`)"
                    @click="actual = !actual"
                >
                    <Icon :name="actual ? `compress` : `expand`" class="text-xs" />
                </button>
                <a
                    v-if="picture?.url"
                    :class="ui.iconButton()"
                    :href="picture.url"
                    :download="fileName"
                    :aria-label="t(`chat.chatShotViewer.download`)"
                    v-tooltip.bottom="t(`chat.chatShotViewer.download`)"
                >
                    <Icon name="download" class="text-xs" />
                </a>
                <button
                    v-if="surface.openFile"
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`chat.chatShotViewer.openInWorkspace`)"
                    v-tooltip.bottom="t(`chat.chatShotViewer.openInWorkspace`)"
                    @click="openInWorkspace"
                >
                    <Icon name="external-link" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" :aria-label="t(`chat.chatShotViewer.close`)" @click="open = false">
                    <Icon name="times" class="text-xs" />
                </button>
            </header>

            <!-- The arrows stand on the stage, outside the part that scrolls, so a picture at actual size can't carry them off. -->
            <div class="relative flex min-h-0 flex-1 bg-canvas">
                <!-- Fit centres the picture; actual size lets it overflow from the top-left and scroll. -->
                <div class="flex min-h-0 min-w-0 flex-1" :class="actual ? `overflow-auto` : `items-center justify-center overflow-hidden p-3`">
                    <img
                        v-if="picture?.url"
                        :src="picture.url"
                        :alt="name"
                        :class="actual ? `max-w-none shrink-0 cursor-zoom-out self-start` : `max-h-full max-w-full cursor-zoom-in rounded-sm object-contain shadow-sm`"
                        @click="actual = !actual"
                    />
                    <p v-else-if="picture" class="m-auto flex items-center gap-1.5 text-xs text-subtle">
                        <Icon name="image" class="text-xs" />{{ t(`chat.chatShotViewer.gone`) }}
                    </p>
                    <Icon v-else name="spinner" spin class="m-auto text-subtle" />
                </div>
                <template v-if="shots.length > 1">
                    <button
                        type="button"
                        :class="ui.iconButton(`absolute top-1/2 left-2 h-9 w-9 -translate-y-1/2 bg-card/80 shadow-sm`)"
                        :disabled="index === 0"
                        :aria-label="t(`chat.chatShotViewer.previous`)"
                        @click="go(index - 1)"
                    >
                        <Icon name="arrow-left" class="text-xs" />
                    </button>
                    <button
                        type="button"
                        :class="ui.iconButton(`absolute top-1/2 right-2 h-9 w-9 -translate-y-1/2 bg-card/80 shadow-sm`)"
                        :disabled="index === shots.length - 1"
                        :aria-label="t(`chat.chatShotViewer.next`)"
                        @click="go(index + 1)"
                    >
                        <Icon name="arrow-right" class="text-xs" />
                    </button>
                </template>
            </div>

            <nav v-if="shots.length > 1" ref="strip" class="flex shrink-0 gap-2 overflow-x-auto border-t border-line px-3 py-2" :aria-label="t(`chat.chatShotViewer.filmstrip`)">
                <template v-for="(group, position) in groups" :key="group.turnId">
                    <span v-if="position > 0" class="w-px shrink-0 self-stretch bg-line" aria-hidden="true" />
                    <div class="flex shrink-0 gap-1">
                        <button
                            v-for="item in group.items"
                            :key="item.shot.key"
                            type="button"
                            class="chat-inset aspect-[16/10] h-12 shrink-0 cursor-pointer overflow-hidden rounded border transition-[border-color,opacity]"
                            :class="item.index === index ? `border-primary-500` : `border-line opacity-60 hover:opacity-100`"
                            :aria-current="item.index === index"
                            :aria-label="t(`chat.chatShotViewer.show`, { name: shotName(item.shot.path) })"
                            @click="go(item.index)"
                        >
                            <img v-if="item.tile?.url" :src="item.tile.url" alt="" class="h-full w-full object-cover object-top" />
                        </button>
                    </div>
                </template>
            </nav>
        </div>
    </Modal>
</template>
