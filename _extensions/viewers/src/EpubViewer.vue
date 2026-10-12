<script setup lang="ts">
import { unzipParts } from "./zip/unzip";
import { Button, Icon, ui } from "@intentic/extension-ui";
import { computed, onMounted, ref, watch } from "vue";
import { openEpub, type EpubBook } from "./epub/book";
import { renderChapter } from "./epub/page";
import { t } from "./i18n.js";
import ViewerStatus from "./load/ViewerStatus.vue";
import { useViewerLoad } from "./load/useViewerLoad.js";

/* EPUB preview: the book's own chapters, each rendered with its own stylesheet inside a frame that can neither run
   a script nor reach the network. */

const { blob } = defineProps<{ blob: Blob }>();

const book = ref<EpubBook>();
const index = ref(0);
const source = ref(``);
const { loading, error, start } = useViewerLoad(() => t(`epubViewer.couldNotOpen`));
const showContents = ref(false);

const chapters = computed(() => book.value?.chapters ?? []);
const current = computed(() => chapters.value[index.value]);

const show = (next: number): void => {
    const opened = book.value;
    if (opened === undefined || next < 0 || next >= opened.chapters.length) {
        return;
    }
    index.value = next;
    showContents.value = false;
    const chapter = opened.chapters[next];
    source.value = chapter === undefined ? `` : renderChapter(opened, chapter.path);
};

const load = (file: Blob): Promise<void> =>
    start(async (isLatest) => {
        source.value = ``;
        book.value = undefined;
        const parts = await unzipParts(new Uint8Array(await file.arrayBuffer()));
        if (!isLatest()) {
            return;
        }
        book.value = openEpub(parts);
        index.value = 0;
        show(0);
    });

onMounted(() => void load(blob));
watch(
    () => blob,
    (next) => void load(next),
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div v-if="book !== undefined" class="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-2xs">
            <button
                type="button"
                :class="ui.chip({ on: showContents }, `shrink-0 gap-1 rounded-md px-1.5 py-0.5 font-medium`)"
                :aria-pressed="showContents"
                @click="showContents = !showContents"
            >
                <Icon name="file-tree" class="text-2xs" /> {{ t(`epubViewer.contents`) }}
            </button>
            <span class="min-w-0 flex-1 truncate text-muted">
                <span class="text-content">{{ book.title }}</span>
                <span v-if="book.author !== undefined"> · {{ book.author }}</span>
            </span>
            <span class="shrink-0 text-subtle">{{ index + 1 }} / {{ chapters.length }}</span>
            <Button size="small" tier="quiet" :disabled="index === 0" @click="show(index - 1)">
                <Icon name="chevron-left" class="text-2xs" />
            </Button>
            <Button size="small" tier="quiet" :disabled="index >= chapters.length - 1" @click="show(index + 1)">
                <Icon name="chevron-right" class="text-2xs" />
            </Button>
        </div>

        <div class="relative min-h-0 flex-1">
            <ViewerStatus :loading="loading" :error="error">
                <div v-if="chapters.length === 0" class="flex h-full items-center justify-center text-sm text-muted">
                    {{ t(`epubViewer.bookNoChaptersIn`) }}
                </div>
                <div v-else class="flex h-full min-h-0">
                    <!-- The book's own table of contents, beside the text rather than over it. -->
                    <nav v-if="showContents" class="w-64 shrink-0 overflow-auto border-r border-line-subtle py-2">
                        <button
                            v-for="(chapter, position) in chapters"
                            :key="chapter.path"
                            type="button"
                            class="block w-full truncate px-3 py-1 text-left text-2xs hover:bg-overlay"
                            :class="position === index ? `text-content font-medium` : `text-muted`"
                            @click="show(position)"
                        >
                            {{ chapter.title }}
                        </button>
                    </nav>
                    <!-- No allow-scripts and no allow-same-origin: the book's markup renders, and can do nothing else. -->
                    <iframe
                        :key="current?.path"
                        :srcdoc="source"
                        sandbox=""
                        referrerpolicy="no-referrer"
                        :title="current?.title ?? t(`epubViewer.chapter`)"
                        class="h-full min-w-0 flex-1 border-0 bg-white"
                    ></iframe>
                </div>
            </ViewerStatus>
        </div>
    </div>
</template>
