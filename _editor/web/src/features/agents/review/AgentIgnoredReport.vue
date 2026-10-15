<script setup lang="ts">
import type { IgnoredOutput } from "@intentic/sandbox-contract";
import { Button, explorerColorClass, formatBytes, iconForEntry, useExplorerStyle } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename, parentDir } from "@intentic/ui/path";
import { computed, ref } from "vue";
import ChangeRowName from "../../../components/ChangeRowName.vue";

// What the conversation made for its owner that the repository's ignore rules keep out of every land: a render in
// `out/`, a report as a PDF. The daemon lists only files a person opens, so build output never reaches this card.
// Drawn as the review's own file rows, each copied into the owner's tree on a press, and all of them from the head.
// A folder holding many (a render's frames) folds into one row, so a long list never buries the rest of the review.

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

// The head carries the whole phrase when it offers copy-all; a lone file's row carries it itself.
const rowCopyLabel = computed(() => (listed.value > 1 ? t(`agents.agentIgnoredReport.copy`) : t(`agents.agentIgnoredReport.copyOne`)));
// Where a copy goes, which the button's own words leave out.
const copyTip = computed(() => ({ title: t(`agents.agentIgnoredReport.outsideGit`), note: t(`agents.agentIgnoredReport.hint`) }));

const ROW = `flex min-w-0 items-center gap-2 py-1 pl-2.5 pr-1.5 max-md:min-h-11`;
const SIZE = `w-14 shrink-0 text-right text-2xs tabular-nums text-subtle`;
</script>

<template>
    <!-- Quiet like the scratch report: nothing failed, and the work below lands without these. -->
    <section class="flex shrink-0 flex-col rounded-md border border-border bg-overlay" :aria-label="t(`agents.agentIgnoredReport.title`, { count }, count)">
        <header class="flex min-h-8 items-center gap-2 py-1 pl-2.5 pr-1.5">
            <Icon name="eye-slash" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 text-2xs">
                <span class="font-medium text-content">{{ t(`agents.agentIgnoredReport.title`, { count }, count) }}</span>
                <span class="text-subtle"> · {{ formatBytes(bytes) }}</span>
            </span>
            <span v-if="streaming" class="shrink-0 text-2xs text-subtle">{{ t(`agents.agentIgnoredReport.afterTurn`) }}</span>
            <Button
                v-else-if="listed > 1"
                size="small"
                tier="boring"
                class="shrink-0 whitespace-nowrap"
                :disabled="locked"
                v-tooltip.bottom="copyTip"
                @click="copyAll"
            >
                <Icon name="download" />{{ t(`agents.agentIgnoredReport.copyAll`) }}
            </Button>
        </header>

        <!-- Held to a few rows, scrolling past them, so an opened folder of frames never pushes the review's own list out. -->
        <ul class="max-h-64 overflow-y-auto border-t border-border py-0.5">
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
                        <Button size="small" tier="quiet" class="shrink-0" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(line.repo, line.files)">
                            {{ t(`agents.agentIgnoredReport.copy`) }}
                        </Button>
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
                            <Button size="small" tier="quiet" class="shrink-0" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(file.repo, [file])">
                                {{ t(`agents.agentIgnoredReport.copy`) }}
                            </Button>
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
                    <Button size="small" tier="quiet" class="shrink-0 whitespace-nowrap" :disabled="locked" v-tooltip.bottom="copyTip" @click="copyFiles(line.file.repo, [line.file])">
                        {{ rowCopyLabel }}
                    </Button>
                </div>
            </li>
        </ul>

        <p v-if="more > 0" class="border-t border-border px-2.5 py-1 text-2xs text-subtle">{{ t(`agents.agentIgnoredReport.more`, { count: more }, more) }}</p>
    </section>
</template>
