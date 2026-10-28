<script setup lang="ts">
import type { IgnoredOutput } from "@intentic/sandbox-contract/schemas/git/git";
import { explorerColorClass, formatBytes, iconForEntry, ui, useExplorerStyle } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, ref, useId } from "vue";
import ChangeRowName from "../../../../components/ChangeRowName.vue";

// What the conversation made for its owner that the repository's ignore rules keep out of every land: a render in
// `out/`, a report as a PDF. The daemon lists only files a person opens, so build output never reaches this card.
// Nothing failed and nothing waits on it, so it is one quiet line under the bar like the review's other notes: how
// many and how big, copy-all, and the list folded behind Show. Opened, each file (or a folder of many, as one row)
// copies on its own press, revealed on hover so the list reads as names and sizes rather than a column of buttons.

const t = useT();
const { explorerStyle } = useExplorerStyle();

export type IgnoredGroup = { readonly repo: string; readonly paths: readonly IgnoredOutput[]; readonly more?: number };

const props = defineProps<{
    ignored: readonly IgnoredGroup[];
    // A land, include, delete or copy this panel has in flight.
    busy: boolean;
    // The copy is a running turn's working state, so nothing is copied out of it until the turn ends.
    streaming: boolean;
}>();

const emit = defineEmits<{ copy: [groups: { repo: string; paths: string[] }[]] }>();

// A folder with this many listed files is one row that opens onto them.
const FOLD_AT = 4;

type File = { readonly key: string; readonly repo: string; readonly output: IgnoredOutput; readonly label: string };
type Line =
    | { readonly kind: `file`; readonly file: File }
    | { readonly kind: `folder`; readonly key: string; readonly repo: string; readonly label: string; readonly files: readonly File[]; readonly bytes: number };

const labelOf = (repo: string, path: string): string => (repo === `root` ? path : `${repo}/${path}`);

// Each repository's files by the folder holding them, in the daemon's path order; a folder of FOLD_AT or more is one
// line, any other file its own.
const lines = computed<Line[]>(() =>
    props.ignored.flatMap((group) => {
        const folders = new Map<string, File[]>();
        for (const output of group.paths) {
            const file = { key: `${group.repo}:${output.path}`, repo: group.repo, output, label: labelOf(group.repo, output.path) };
            const folder = parentDir(output.path);
            folders.set(folder, [...(folders.get(folder) ?? []), file]);
        }
        return [...folders].flatMap(([folder, files]): Line[] =>
            files.length < FOLD_AT
                ? files.map((file) => ({ kind: `file`, file }))
                : [
                      {
                          kind: `folder`,
                          key: `${group.repo}:${folder}/`,
                          repo: group.repo,
                          label: labelOf(group.repo, folder),
                          files,
                          bytes: files.reduce((total, file) => total + file.output.bytes, 0),
                      },
                  ],
        );
    }),
);

const listed = computed(() => props.ignored.reduce((total, group) => total + group.paths.length, 0));
const more = computed(() => props.ignored.reduce((total, group) => total + (group.more ?? 0), 0));
const count = computed(() => listed.value + more.value);
const bytes = computed(() => props.ignored.reduce((total, group) => total + group.paths.reduce((sum, output) => sum + output.bytes, 0), 0));
const locked = computed(() => props.busy || props.streaming);

// Whether the list under the line is open; folded at first, since the line already says what and how much.
const shown = ref(false);
const listId = useId();

// Folders the owner opened, by key.
const open = ref(new Set<string>());
const toggle = (key: string): void => {
    const next = new Set(open.value);
    if (!next.delete(key)) {
        next.add(key);
    }
    open.value = next;
};

const copyFiles = (repo: string, files: readonly File[]): void => {
    emit(`copy`, [{ repo, paths: files.map((file) => file.output.path) }]);
};

const copyAll = (): void => {
    emit(
        `copy`,
        props.ignored.filter((group) => group.paths.length > 0).map((group) => ({ repo: group.repo, paths: group.paths.map((output) => output.path) })),
    );
};

// The line's copy names where the files go; a row's says only "Copy", the line above having said the rest.
const copyAllLabel = computed(() => (listed.value > 1 ? t(`agents.agentIgnoredReport.copyAll`) : t(`agents.agentIgnoredReport.copyOne`)));
// Where a copy goes, which the button's own words leave out.
const copyTip = computed(() => ({ title: t(`agents.agentIgnoredReport.outsideGit`), note: t(`agents.agentIgnoredReport.hint`) }));

// A notice that needs no decision: one line under the bar, no box, as ReviewNotes draws its others.
const NOTE_LINE = `mx-2 mt-1.5 flex min-w-0 items-center gap-3 px-2 text-2xs text-muted`;
const ROW = `group flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5 hover:bg-overlay max-md:min-h-11`;
// A row's copy, shown on hover or focus where there is a pointer, always on touch.
const ROW_COPY = ui.textButton({ size: `xs`, flush: true }, `shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100`);
const SIZE = `w-14 shrink-0 text-right text-2xs tabular-nums text-subtle`;
</script>

<template>
    <section class="shrink-0" :aria-label="t(`agents.agentIgnoredReport.title`, { count }, count)">
        <header :class="NOTE_LINE">
            <span class="flex min-w-0 flex-1 items-center gap-1.5">
                <Icon name="eye-slash" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 truncate">
                    {{ t(`agents.agentIgnoredReport.title`, { count }, count) }}<span class="text-subtle"> · {{ formatBytes(bytes) }}</span>
                </span>
            </span>
            <button
                v-if="lines.length > 0"
                type="button"
                :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)"
                :aria-expanded="shown"
                :aria-controls="listId"
                @click="shown = !shown"
            >
                {{ shown ? t(`agents.agentIgnoredReport.hide`) : t(`agents.agentIgnoredReport.show`) }}
                <Icon :name="shown ? 'chevron-up' : 'chevron-down'" class="text-[0.6rem]" />
            </button>
            <span v-if="streaming" class="shrink-0 text-subtle">{{ t(`agents.agentIgnoredReport.afterTurn`) }}</span>
            <button
                v-else-if="listed > 0"
                type="button"
                :class="ui.textButton({ size: `xs` }, `shrink-0 whitespace-nowrap`)"
                :disabled="locked"
                v-tooltip.bottom="copyTip"
                @click="copyAll"
            >
                {{ copyAllLabel }}
            </button>
        </header>

        <!-- Bounded and scrolled on its own, so an opened folder of frames never pushes the review's own list out. -->
        <ul v-if="shown" :id="listId" class="mx-2 mt-1 max-h-48 overflow-y-auto rounded-md border border-line p-0.5 text-2xs">
            <li v-for="line in lines" :key="line.kind === `file` ? line.file.key : line.key">
                <!-- A folder of many: one row, its files behind the chevron. -->
                <template v-if="line.kind === `folder`">
                    <div :class="ROW">
                        <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-2 text-left"
                            :aria-expanded="open.has(line.key)"
                            :aria-label="line.label"
                            @click="toggle(line.key)"
                        >
                            <Icon :name="open.has(line.key) ? `chevron-down` : `chevron-right`" class="w-3 shrink-0 text-2xs text-subtle" />
                            <Icon :name="iconForEntry(basename(line.label), 'dir', open.has(line.key))" class="shrink-0 text-2xs text-subtle" />
                            <ChangeRowName :path="line.label" :label="line.label" :named="false" />
                            <span class="shrink-0 text-2xs text-subtle">{{ t(`agents.agentIgnoredReport.files`, { count: line.files.length }, line.files.length) }}</span>
                        </button>
                        <span :class="SIZE">{{ formatBytes(line.bytes) }}</span>
                        <button type="button" :class="ROW_COPY" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(line.repo, line.files)">
                            {{ t(`agents.agentIgnoredReport.copy`) }}
                        </button>
                    </div>
                    <ul v-if="open.has(line.key)" class="pl-5">
                        <li v-for="file in line.files" :key="file.key" :class="ROW">
                            <Icon
                                :name="iconForEntry(basename(file.output.path), 'file', false)"
                                class="shrink-0 text-2xs"
                                :class="explorerColorClass(explorerStyle, basename(file.output.path), 'file', false)"
                            />
                            <ChangeRowName :path="file.output.path" :label="file.label" :named="true" />
                            <span v-if="file.output.kind === `changed`" class="shrink-0 text-2xs text-warning">{{
                                t(`agents.agentIgnoredReport.replaces`)
                            }}</span>
                            <span :class="SIZE">{{ formatBytes(file.output.bytes) }}</span>
                            <button type="button" :class="ROW_COPY" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(file.repo, [file])">
                                {{ t(`agents.agentIgnoredReport.copy`) }}
                            </button>
                        </li>
                    </ul>
                </template>
                <div v-else :class="ROW">
                    <Icon
                        :name="iconForEntry(basename(line.file.output.path), 'file', false)"
                        class="shrink-0 text-2xs"
                        :class="explorerColorClass(explorerStyle, basename(line.file.output.path), 'file', false)"
                    />
                    <ChangeRowName :path="line.file.label" :label="line.file.label" :named="false" />
                    <!-- Only the case worth a word: a new file is the usual one. -->
                    <span v-if="line.file.output.kind === `changed`" class="shrink-0 text-2xs text-warning">{{
                        t(`agents.agentIgnoredReport.replaces`)
                    }}</span>
                    <span :class="SIZE">{{ formatBytes(line.file.output.bytes) }}</span>
                    <button type="button" :class="ROW_COPY" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(line.file.repo, [line.file])">
                        {{ t(`agents.agentIgnoredReport.copy`) }}
                    </button>
                </div>
            </li>
            <li v-if="more > 0" class="px-1.5 py-0.5 text-subtle">{{ t(`agents.agentIgnoredReport.more`, { count: more }, more) }}</li>
        </ul>
    </section>
</template>
