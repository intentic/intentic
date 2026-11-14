<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { type ChatShot, shotName } from "./shots";
import { downloadOriginal, picture } from "../../../../models/workspace/home/thumbnails";
import { agentScope } from "../../../../app/workspaceScope";
import PictureViewer, { type ViewerPicture } from "../attachments/PictureViewer.vue";

// The conversation's pictures one at a time and large, opened from a strip's tile or a tool card's picture; the arrows
// walk every turn's strip in order and the filmstrip jumps, one run of it per turn. It draws the daemon's re-encoded view
// at once and swaps in the original file once that arrives: opening a picture is asking to look at it, and the
// re-encode, however good, is lossy where the file is not. The frame is the one a page's pictures open in (PictureViewer).

const t = useT();

const props = defineProps<{
    shots: readonly ChatShot[];
    // The shot it opens at, by key; a key the list no longer holds opens at the first.
    start: string | undefined;
    // Whose checkout the pictures are read in (thumbnails.ts), undefined for the shared tree.
    agent: string | undefined;
    // What each turn was asked, by turn id, for the caption.
    prompts: ReadonlyMap<number, string>;
}>();

const open = defineModel<boolean>("open", { required: true });

const surface = useChatSurface();

// Where the viewer stands, by key rather than position, so a live turn adding pictures doesn't move what is on screen.
const at = ref<string>();

watch(
    open,
    (opened) => {
        if (opened) {
            at.value = props.start;
        }
    },
    { immediate: true },
);

const index = computed(() =>
    Math.max(
        0,
        props.shots.findIndex((shot) => shot.key === at.value),
    ),
);
const shot = computed<ChatShot | undefined>(() => props.shots[index.value]);
const view = computed(() => (shot.value === undefined ? undefined : picture(agentScope(props.agent), shot.value.path, `view`)));
// Asked for the picture on screen only; the neighbours fetched ahead are views, so walking past costs no originals.
const original = computed(() => (shot.value === undefined ? undefined : picture(agentScope(props.agent), shot.value.path, `original`)));
// The view is the picture at its own size, so it stands in for the original, at fit and at actual size, until the file arrives.
const drawn = computed(() => (original.value?.url === undefined ? view.value : original.value));
const prompt = computed(() => (shot.value === undefined ? undefined : props.prompts.get(shot.value.turnId)));

const pictures = computed<readonly ViewerPicture[]>(() =>
    props.shots.map((each) => ({ key: each.key, name: shotName(each.path), tile: picture(agentScope(props.agent), each.path, `strip`)?.url, group: each.turnId })),
);

// The pictures either side of this one start coming now, so the arrows land on pictures already here.
watch(
    index,
    (position) => {
        for (const neighbour of [props.shots[position - 1], props.shots[position + 1]]) {
            if (neighbour !== undefined) {
                picture(agentScope(props.agent), neighbour.path, `view`);
            }
        }
    },
    { immediate: true },
);

const download = (): void => {
    if (shot.value !== undefined) {
        void downloadOriginal(agentScope(props.agent), shot.value.path);
    }
};

const openInWorkspace = (): void => {
    const current = shot.value;
    if (current === undefined) {
        return;
    }
    open.value = false;
    surface.openFile?.(current.path);
};
</script>

<template>
    <PictureViewer
        v-model:open="open"
        v-model:at="at"
        :pictures="pictures"
        :drawn="drawn"
        :caption="prompt"
        :filmstrip="t(`chat.chatShotViewer.filmstrip`)"
    >
        <template #actions>
            <button
                v-if="view?.url"
                type="button"
                :class="ui.iconButton()"
                :aria-label="t(`chat.pictureViewer.download`)"
                v-tooltip.bottom="t(`chat.pictureViewer.download`)"
                @click="download"
            >
                <Icon name="download" class="text-xs" />
            </button>
            <button
                v-if="surface.openFile"
                type="button"
                :class="ui.iconButton()"
                :aria-label="t(`chat.words.openFile`)"
                v-tooltip.bottom="t(`chat.words.openFile`)"
                @click="openInWorkspace"
            >
                <Icon name="external-link" class="text-xs" />
            </button>
        </template>
    </PictureViewer>
</template>
