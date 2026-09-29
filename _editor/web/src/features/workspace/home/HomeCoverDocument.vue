<!-- One folder's cover on the home: the chosen file read and drawn in place, or, when the folder has none, where one is. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { Code, formatBytes, Markdown, ui, useLatest, useLoadingReveal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { fileLinkDecorator } from "../../../lib/markdown/renderMarkdown";
import { resolveFile } from "../explorer/fileType";
import { readFileWindow } from "../files/fileWindow";
import { openFileRefFromEvent } from "../files/refs/openFileRef";
import { workspaceAgent } from "../health/workspaceScope";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { quickLookPlan } from "./quickLookContent";
import { picture } from "./thumbnails";

// Reads the file it is handed, never the listing: HomeCover decides which file answers for the folder, and this draws it
// the way its tab would, read-only. Markdown is prose, other text is highlighted, a picture is drawn; anything else
// says it opens in a tab of its own.

const t = useT();

const {
    folder,
    here,
    name,
    entry,
    listed,
    below,
} = defineProps<{
    // The folder this is the cover of, and what the empty state calls it; the breadcrumb above says where it is.
    folder: string;
    here: string;
    // The cover name, for saying what is missing.
    name: string;
    // The file that answers for the name; undefined while the folder is unlisted, and when it holds none.
    entry: WorkspaceTreeEntry | undefined;
    listed: boolean;
    // Folders below this one holding a cover, nearest first, each with how this folder reaches it.
    below: readonly { readonly path: string; readonly label: string }[];
}>();

const emit = defineEmits<{ reveal: [folder: string]; exit: [] }>();

const { openFile } = useWorkspaceTabs();

// What the file is drawn as. The quick look's plan decides what can be drawn at all; markdown is told apart from other
// text here, since a cover is read, where a quick look only glances.
type CoverLook = "markdown" | "text" | "picture" | "empty" | "tab";
const look = computed<CoverLook | undefined>(() => {
    if (entry === undefined) {
        return undefined;
    }
    if (entry.size === 0) {
        return `empty`;
    }
    const plan = quickLookPlan(entry).kind;
    if (plan === `picture`) {
        return `picture`;
    }
    if (plan !== `text`) {
        return `tab`;
    }
    return resolveFile(entry.path, entry.size).mode === `markdown` ? `markdown` : `text`;
});
const lang = computed(() => (entry === undefined ? undefined : resolveFile(entry.path, entry.size).lang));

// --- Reading ---------------------------------------------------------------------------------------------------------
// Past this a cover is cut, not refused: its top is what a reader flipping through folders came for, and the rest is
// one Open away. It is also where the prose pipeline stops keeping up (MarkdownViewer's own cap).
const COVER_BYTES = 256 * 1024;
// A flip through folders asks for a file only once the reader stops on it; a held arrow key asks for none between.
const SETTLE_MS = 90;
// Enough to flip back over a stretch of folders without a round trip.
const KEPT = 24;

// `shown` is how many bytes of the file `text` holds, which is less than its size when the file was cut.
type Reading =
    | { readonly kind: `text`; readonly text: string; readonly shown: number; readonly cut: boolean }
    | { readonly kind: `binary` }
    | { readonly kind: `unreadable` };
const reading = shallowRef<Reading>();
const kept = new Map<string, Reading>();
const keep = (key: string, value: Reading): void => {
    kept.delete(key);
    kept.set(key, value);
    const [oldest] = kept.keys();
    if (kept.size > KEPT && oldest !== undefined) {
        kept.delete(oldest);
    }
};
// A rewritten file (same path, a new size) is read again.
const keyOf = (target: WorkspaceTreeEntry): string => `${target.path} ${target.size ?? 0}`;

const latest = useLatest();
let controller: AbortController | undefined;
let settling: ReturnType<typeof setTimeout> | undefined;

const fetchText = async (target: WorkspaceTreeEntry, isLatest: () => boolean): Promise<void> => {
    controller = new AbortController();
    const { signal } = controller;
    try {
        const window = await readFileWindow(target.path, { limit: COVER_BYTES, signal });
        const value: Reading = !window.present
            ? { kind: `unreadable` }
            : window.content.includes(`\0`)
              ? { kind: `binary` }
              : { kind: `text`, text: window.content, shown: window.bytes, cut: window.bytes < window.size };
        keep(keyOf(target), value);
        if (isLatest()) {
            reading.value = value;
        }
    } catch (failure) {
        // Aborted: a later folder took over, and it is the one to draw. Refused or unreachable: said on the page.
        if (isLatest() && !signal.aborted) {
            reading.value = { kind: `unreadable` };
            console.warn(`[home] could not read the cover ${target.path}`, failure);
        }
    }
};

const read = (): void => {
    controller?.abort();
    clearTimeout(settling);
    const isLatest = latest();
    const target = entry;
    if (target === undefined || (look.value !== `markdown` && look.value !== `text`)) {
        reading.value = undefined;
        return;
    }
    const known = kept.get(keyOf(target));
    reading.value = known;
    if (known === undefined) {
        settling = setTimeout(() => void fetchText(target, isLatest), SETTLE_MS);
    }
};
// Keyed on the file and how it is drawn, not the entry object: a listing refreshed around the same file must not abort
// a read already on its way.
watch(() => (entry === undefined ? `` : `${keyOf(entry)}\n${look.value ?? ``}`), read, { immediate: true });
onBeforeUnmount(() => {
    controller?.abort();
    clearTimeout(settling);
});

const text = computed(() => (reading.value?.kind === `text` ? reading.value : undefined));

// A picture comes from the same cache the tiles fill, at the size a viewer draws it; undefined while it is on its way,
// and a url of undefined when the daemon has nothing to draw.
const drawn = computed(() => (entry === undefined || look.value !== `picture` ? undefined : picture(workspaceAgent.value, entry.path, `view`)));

// Still arriving: the folder's listing, the file's text, or its picture.
const waiting = computed(() => {
    if (entry === undefined) {
        return !listed;
    }
    if (look.value === `picture`) {
        return drawn.value === undefined;
    }
    return (look.value === `markdown` || look.value === `text`) && reading.value === undefined;
});
const revealed = useLoadingReveal(
    waiting,
    computed(() => folder),
);
// Nothing this pane can draw of a file it has: a format that opens in its own tab, bytes after all, or a read refused.
const undrawable = computed(
    () =>
        look.value === `tab` ||
        reading.value?.kind === `binary` ||
        reading.value?.kind === `unreadable` ||
        (look.value === `picture` && drawn.value !== undefined && drawn.value.url === undefined),
);

// Relative links resolve against the file's own folder, and open in the reader's own scope, as the tab's do; a picture
// beside the document is drawn from its own bytes in that scope (MarkdownViewer.vue).
const decorate = computed(() => {
    const agent = workspaceAgent.value;
    return fileLinkDecorator({ dir: folder === `` ? `` : `${folder}/`, agent, picture: (file) => picture(agent, file, `original`)?.url });
});

const open = (): void => {
    if (entry !== undefined) {
        openFile(entry.path, `keep`);
    }
};

// Every folder's file starts at its top; one a reader scrolled down in and left is not where the next begins.
const scroller = ref<HTMLElement>();
watch([() => folder, () => entry?.path], () => scroller.value?.scrollTo({ top: 0 }));
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="t(`workspace.homeCover.document`, { name: entry?.name ?? name, here })">
        <!-- Takes focus on a click but is no tab stop, so the arrows and Space then scroll the page, as in any document; the
             tree beside it is where the keys move between folders. -->
        <div ref="scroller" class="ui-softscroll min-h-0 flex-1 overflow-auto focus:outline-none" tabindex="-1">
            <!-- A wait long enough to show: line-shaped placeholders, still, in a document's measure. -->
            <div v-if="revealed" class="mx-auto flex max-w-3xl flex-col gap-2.5 px-8 py-7" aria-hidden="true">
                <div class="skeleton h-4 w-1/3"></div>
                <div class="skeleton h-3 w-5/6"></div>
                <div class="skeleton h-3 w-2/3"></div>
                <div class="skeleton h-3 w-3/4"></div>
            </div>

            <!-- None here: said once, with the nearest folders below that have one, and the way back to the tiles. -->
            <div v-else-if="entry === undefined && listed" class="flex flex-col items-center gap-3 px-6 py-14 text-center">
                <Icon name="book" class="text-2xl text-subtle" aria-hidden="true" />
                <p class="text-xs text-muted">{{ t(`workspace.homeCover.noneIn`, { name, here }) }}</p>
                <template v-if="below.length > 0">
                    <p class="pt-2 text-2xs text-subtle">{{ t(`workspace.homeCover.foundBelow`, { count: below.length }, below.length) }}</p>
                    <ul class="flex flex-col items-center gap-0.5">
                        <li v-for="place in below" :key="place.path">
                            <button type="button" :class="ui.textAction(`min-h-7 gap-1.5 text-xs`)" @click="emit(`reveal`, place.path)">
                                <Icon name="folder" class="text-2xs text-subtle" aria-hidden="true" />
                                {{ place.label }}
                            </button>
                        </li>
                    </ul>
                </template>
                <button type="button" :class="ui.textAction(`mt-2 text-2xs`)" @click="emit(`exit`)">
                    {{ t(`workspace.homeCover.showAllFiles`) }}
                </button>
            </div>

            <template v-else-if="entry !== undefined">
                <!-- Prose, as the tab reads it; a click on a file it mentions opens that file. -->
                <div v-if="look === `markdown` && text !== undefined" class="px-8 py-7" @click="openFileRefFromEvent">
                    <Markdown :source="text.text" :decorate="decorate" class="mx-auto max-w-3xl" />
                </div>
                <!-- The block's own frame is dropped: the pane is already the frame, and a card inside it reads as a hole. -->
                <div
                    v-else-if="look === `text` && text !== undefined"
                    class="px-3 py-3 [&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:px-2"
                >
                    <Code :code="text.text" :lang="lang" :copyable="false" />
                </div>
                <div v-else-if="look === `picture` && drawn?.url !== undefined" class="flex h-full items-center justify-center p-6">
                    <img :src="drawn.url" :alt="entry.name" class="max-h-full max-w-full rounded-sm object-contain ring-1 ring-line/60" />
                </div>
                <p v-else-if="look === `empty`" class="px-6 py-14 text-center text-xs text-muted">
                    {{ t(`workspace.homeCover.empty`, { name: entry.name }) }}
                </p>
                <div v-else-if="undrawable" class="flex flex-col items-center gap-3 px-6 py-14 text-center">
                    <p class="text-xs text-muted">
                        {{
                            reading?.kind === `unreadable`
                                ? t(`workspace.homeCover.couldNotRead`, { name: entry.name })
                                : t(`workspace.homeCover.notText`, { name: entry.name })
                        }}
                    </p>
                    <button type="button" :class="ui.textAction(`text-2xs`)" @click="open">{{ t(`ui.action.open`) }}</button>
                </div>

                <!-- The top of a long file is what a cover shows; the rest is the tab's. -->
                <p v-if="text?.cut === true" class="flex items-center justify-center gap-2 px-6 pb-8 text-2xs text-subtle">
                    {{ t(`workspace.homeCover.cut`, { size: formatBytes(text.shown), name: entry.name }) }}
                    <button type="button" :class="ui.linkButton(`text-2xs`)" @click="open">{{ t(`workspace.homeCover.openWhole`) }}</button>
                </p>
            </template>
        </div>
    </section>
</template>
