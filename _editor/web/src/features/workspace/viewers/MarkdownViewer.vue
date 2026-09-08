<script setup lang="ts">
import { Button, ui, Icon, MarkdownDocument, ResponsiveOverlay, useNarrow } from "@intentic/ui";
import { type MarkdownDecorator, offsetOfLine } from "@intentic/ui/markdown";
import { computed, inject, ref, watch } from "vue";
import { fileLinkDecorator } from "../../../lib/markdown/renderMarkdown";
import { useLayout } from "../../../shell/window/useLayout";
import { openFileRefFromEvent } from "../files/openFileRef";
import { workspaceAgent } from "../health/workspaceScope";
import type { LineJump } from "../tabs/workspaceTabs";
import CodeView from "./CodeView.vue";
import MarkdownOutline from "./MarkdownOutline.vue";
import { toggleTaskCheckbox } from "./markdownTasks";
import { useMarkdownOutline } from "./markdownOutline";
import { CHROME_SCOPE, viewerActionsTarget } from "../files/viewerChrome";

// Markdown surface: one document (kit's <MarkdownDocument>), rendered in both reading and editing states; the
// app's ordinary Edit switch decides which. Source view is an escape hatch, not half a toggle: Monaco, since a
// file can be huge, and where a search hit (a line fact) lands. Checkbox ticks are live while reading.

// `line`: a content-search hit landing here; `editable` is the host's permission, not whether editing is on.
const { source, path, line, editable } = defineProps<{ source: string; path: string; line?: LineJump; editable?: boolean }>();
const emit = defineEmits<{ change: [value: string]; save: [value: string] }>();

const layout = useLayout();
// Which pane's breadcrumb these controls ride; with two panes open there are two of them.
const scope = inject(CHROME_SCOPE, `main`);

// Held, not watched, like the editable CodeView: `source` seeds it, and this surface owns the text after mount.
const doc = ref(source);
// Where to put the caret when the editing surface mounts: a content-search hit, or nothing.
const landing = ref<number | undefined>(undefined);

// Past this, the synchronous render pipeline doesn't scale; source view (Monaco) renders only visible lines.
const PROSE_MAX_CHARS = 256 * 1024;
const heavy = source.length > PROSE_MAX_CHARS;
const view = ref<`document` | `source`>(heavy ? `source` : `document`);

// Editable only when the host allows it and the app's Edit switch is on, the same switch every file answers to.
const editing = computed(() => editable === true && layout.editMode.value && view.value === `document`);

// Held as a computed so identity is stable and the component re-parses only when the decorator changes; a doc
// cross-referencing others (README → ARCHITECTURE.md) navigates within the reader's own scope.
const decorate = computed<MarkdownDecorator>(() => {
    const links = fileLinkDecorator({ dir: path.slice(0, path.lastIndexOf(`/`) + 1), agent: workspaceAgent.value });
    const tickable = editable === true;
    return (fragment) => {
        links(fragment);
        // marked disables task boxes by default; enabling them makes a checklist here behave like any other.
        if (tickable) {
            for (const box of fragment.querySelectorAll<HTMLInputElement>(`input[type="checkbox"]`)) {
                box.removeAttribute(`disabled`);
                box.classList.add(`md-task-box`);
            }
        }
    };
});

const scroller = ref<HTMLElement>();
const outline = useMarkdownOutline(scroller);
const surface = ref<InstanceType<typeof MarkdownDocument>>();
const sourceView = ref<InstanceType<typeof CodeView>>();

const onChange = (value: string): void => {
    doc.value = value;
    emit(`change`, value);
};

const save = (): void => {
    if (view.value === `source`) {
        sourceView.value?.save();
        return;
    }
    emit(`save`, surface.value?.text() ?? doc.value);
};
defineExpose({ save });

// Clicks while reading: a file mention opens it, a checkbox ticks; while editing, the same characters are just
// text under the caret.
const onPreviewClick = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === `checkbox`) {
        event.preventDefault();
        const boxes = [...(scroller.value?.querySelectorAll(`.md-prose input[type="checkbox"]`) ?? [])];
        const next = toggleTaskCheckbox(doc.value, boxes.indexOf(target));
        if (next !== undefined) {
            onChange(next);
        }
        return;
    }
    openFileRefFromEvent(event);
};

// A search hit is a line: while editing that's a caret offset, but rendered prose has no stable line mapping,
// so it lands in source view instead.
watch(
    () => line,
    (next) => {
        if (next === undefined) {
            return;
        }
        if (editable === true && layout.editMode.value && !heavy) {
            view.value = `document`;
            landing.value = offsetOfLine(doc.value, next.line);
            return;
        }
        view.value = `source`;
    },
    { immediate: true },
);

// Below three sections the first screen already shows the whole table of contents; a rail would repeat it.
const OUTLINE_MIN = 3;
const worthIt = computed(() => outline.headings.value.length >= OUTLINE_MIN);

// Measured off the pane, not the window; below it the rail doesn't dock, just one press away in the toolbar.
const RAIL_AT_REM = 57;
const root = ref<HTMLElement>();
const narrow = useNarrow(root, RAIL_AT_REM);

const docked = computed(() => view.value === `document` && worthIt.value && !narrow.value && layout.markdownOutline.value);
// The rail's own control, so it is absent where it would promise something the pane cannot give.
const dockable = computed(() => view.value === `document` && worthIt.value && !narrow.value);
// "You are here" for when the rail isn't showing; doubles as the overlay outline's opener.
const current = computed(() =>
    view.value === `document` && worthIt.value && !docked.value ? outline.headings.value[outline.active.value]?.text : undefined,
);

const overlayOpen = ref(false);
const opener = ref<HTMLElement>();
const jumpFromOverlay = (index: number): void => {
    overlayOpen.value = false;
    outline.jump(index);
};

// Overlay may open only while its opener exists: docking the rail, switching to Source, or widening past the
// threshold takes the button away. Also closes when the document changes underneath (reused tab).
// Watches "is there an opener", not the section name, or scrolling past a heading would close the panel too.
watch([() => current.value === undefined, () => path], () => (overlayOpen.value = false));
</script>

<template>
    <div ref="root" class="flex h-full min-h-0 flex-col">
        <!--
            No bar of its own: three controls and a section name aren't a toolbar's worth, so they ride the breadcrumb
            instead of pushing prose down another row.
        -->
        <Teleport defer :to="`#${viewerActionsTarget(scope)}`">
            <!--
                Section the reader is in; a button, not a label, since the list behind it is wanted often enough, and it's
                the only way to it on a pane too narrow to dock.
            -->
            <Button
                v-if="current !== undefined"
                ref="opener"
                size="small"
                severity="secondary"
                :text="true"
                class="min-w-0"
                v-tooltip.bottom="'Outline'"
                @click="overlayOpen = !overlayOpen"
            >
                <Icon name="align-left" class="shrink-0 text-subtle" aria-hidden="true" />
                <!--
                    Narrower than it was on its own bar, since this now shares a row with the tab strip; the glyph alone still
                    opens the outline.
                -->
                <span class="max-w-32 truncate max-md:hidden">{{ current }}</span>
            </Button>

            <button
                v-if="dockable"
                type="button"
                :class="ui.iconButton()"
                :aria-pressed="docked"
                v-tooltip.bottom="docked ? `Hide outline` : `Show outline`"
                :aria-label="docked ? `Hide outline` : `Show outline`"
                @click="layout.toggleMarkdownOutline()"
            >
                <Icon name="align-left" />
            </button>

            <!--
                The way out, not half of a toggle: source is for what prose can't express (a blank line between blocks, a
                swallowed construct, a matched search line).
            -->
            <button
                type="button"
                :class="ui.iconButton()"
                :aria-pressed="view === `source`"
                v-tooltip.bottom="view === `source` ? `Back to the document` : `View markdown source`"
                :aria-label="view === `source` ? `Back to the document` : `View markdown source`"
                @click="view = view === `source` ? `document` : `source`"
            >
                <Icon :name="view === `source` ? `eye` : `code`" />
            </button>
        </Teleport>

        <div class="relative flex min-h-0 flex-1">
            <!--
                A reading position is a hairline's worth of info, not a bar's; absent when the document fits its pane, or a
                full-width line would misread as a finished progress bar.
            -->
            <div
                v-if="view === `document` && outline.scrollable.value"
                class="pointer-events-none absolute left-0 top-0 z-10 h-px bg-link/60"
                :style="{ width: `${outline.progress.value * 100}%` }"
                aria-hidden="true"
            ></div>
            <template v-if="view === `document`">
                <!--
                    Scroller spans the whole pane, scrollbar at its edge, rail parked in padding rather than beside it. Left
                    padding fits markdown's hanging markers in both states (like VSCode's), so toggling Edit never shifts the column.
                -->
                <div
                    ref="scroller"
                    class="ui-softscroll h-full min-w-0 flex-1 overflow-auto bg-canvas py-5 pl-12"
                    :class="docked ? `pr-[18.5rem]` : `pr-6`"
                    @click="editing ? undefined : onPreviewClick($event)"
                >
                    <!--
                        Same document, same type, in both states: reading uses the app's one prose engine, editing rebuilds it from
                        source for a real caret. `save="none"`: FileViewer owns saving; re-keyed on path so undo never reaches into the last file.
                    -->
                    <MarkdownDocument
                        ref="surface"
                        :key="path"
                        v-model="doc"
                        :editable="editing"
                        save="none"
                        :caret-at="landing"
                        :decorate="decorate"
                        :label="path"
                        class="mx-auto max-w-3xl"
                        @change="onChange"
                        @save="(value: string) => emit(`save`, value)"
                    />
                </div>
                <!--
                    Parked in that padding, outside the scroller, so it neither scrolls with the document nor slides with a wide
                    table. No border here: rows already draw one, and canvas colour covers content scrolling under it.
                -->
                <aside
                    v-if="docked"
                    class="absolute inset-y-0 flex w-72 flex-col bg-canvas py-5 pl-2 pr-2"
                    :style="{ right: `${outline.gutter.value}px` }"
                >
                    <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="outline.jump" />
                </aside>
            </template>
            <!-- The escape hatch, editable on exactly the same terms as the document above. -->
            <CodeView
                v-else
                ref="sourceView"
                :key="path"
                class="min-w-0 flex-1"
                :code="doc"
                :path="path"
                lang="markdown"
                :editable="editable === true && layout.editMode.value"
                :scroll-to-line="line"
                @change="onChange"
                @save="(value) => emit(`save`, value)"
            />
        </div>

        <!--
            Same outline, for panes that can't dock one (or a peek after the rail is off); anchored to the section
            button on desktop, a sheet on phone.
        -->
        <ResponsiveOverlay v-model="overlayOpen" :anchor="opener" header="Outline" panel-class="max-h-[60vh] w-72 p-2">
            <MarkdownOutline :headings="outline.headings.value" :active="outline.active.value" @jump="jumpFromOverlay" />
        </ResponsiveOverlay>
    </div>
</template>

<style scoped>
/* A task box is a control, not a word: it never takes the text cursor. */
:deep(.md-task-box) {
    cursor: pointer;
}
</style>
