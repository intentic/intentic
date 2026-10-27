<script setup lang="ts">
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import ChatCodeBody from "../../transcript/ChatCodeBody.vue";
import ChatFoldClamp from "../../transcript/ChatFoldClamp.vue";
import ShellMatches from "./ShellMatches.vue";
import ShellPathRow from "./ShellPathRow.vue";
import { type CommandSection, lineCountOf } from "./shellOutput";

// One piece of a command's output, drawn as what it is (shellOutput.ts): a file slice under its path and line range, a
// search's hits, a listing, a status or a log as columns, highlighted or plain text. Every piece folds to its first
// lines (ChatFoldClamp) and reads at full contrast: it is the result, not chrome.

const props = defineProps<{
    section: CommandSection;
    openFile?: ((path: string, line?: number) => void) | undefined;
}>();

const t = useT();

const openable = computed(() => props.openFile !== undefined);

// A slice's line range ("125–200") where its first line is known, else its size.
const range = computed(() => {
    if (props.section.kind !== `code`) {
        return undefined;
    }
    const count = lineCountOf(props.section.code);
    const first = props.section.firstLine;
    return first === undefined ? t(`chat.toolPresentation.lines`, { count }, count) : `${first}–${first + count - 1}`;
});

const lineCount = computed(() => (props.section.kind === `text` ? lineCountOf(props.section.text) : 0));

// A porcelain status code in git's own colours: added green, deleted red, changed amber.
const statusTone = (code: string): string => {
    if (code.includes(`D`)) {
        return `text-danger`;
    }
    if (code.includes(`?`) || code.includes(`A`)) {
        return `text-success`;
    }
    return code.trim() === `` ? `text-subtle` : `text-warning`;
};

const cut = (path: string): number => path.lastIndexOf(`/`) + 1;
</script>

<template>
    <div class="min-w-0">
        <template v-if="section.kind === `code`">
            <ShellPathRow :path="section.path" :meta="range" :openable="openable" @open="openFile?.(section.open, section.firstLine)" />
            <ChatCodeBody bare :code="section.code" :lang="section.lang" :first-line="section.firstLine" />
        </template>
        <ShellMatches v-else-if="section.kind === `matches`" :section="section" :open-file="openFile" />
        <ChatFoldClamp v-else-if="section.kind === `paths`" :lines="section.entries.length">
            <div class="flex min-w-max flex-col py-1">
                <component
                    :is="openable ? 'button' : 'div'"
                    v-for="entry in section.entries"
                    :key="entry.path"
                    :type="openable ? 'button' : undefined"
                    class="px-2.5 text-left font-mono whitespace-nowrap"
                    :class="openable && 'transition-colors hover:bg-overlay'"
                    @click="openFile?.(entry.open)"
                    ><span class="text-subtle">{{ entry.path.slice(0, cut(entry.path)) }}</span
                    ><span class="text-content">{{ entry.path.slice(cut(entry.path)) }}</span></component
                >
            </div>
        </ChatFoldClamp>
        <ChatFoldClamp v-else-if="section.kind === `status`" :lines="section.entries.length + (section.branch === undefined ? 0 : 1)">
            <div class="flex min-w-max flex-col py-1 font-mono">
                <span v-if="section.branch" class="px-2.5 text-subtle">{{ section.branch }}</span>
                <component
                    :is="openable ? 'button' : 'div'"
                    v-for="entry in section.entries"
                    :key="entry.path"
                    :type="openable ? 'button' : undefined"
                    class="flex gap-2 px-2.5 text-left whitespace-nowrap"
                    :class="openable && 'transition-colors hover:bg-overlay'"
                    @click="openFile?.(entry.open)"
                >
                    <span class="w-4 shrink-0 font-medium whitespace-pre" :class="statusTone(entry.code)">{{ entry.code }}</span>
                    <span class="text-content">{{ entry.path }}</span>
                </component>
            </div>
        </ChatFoldClamp>
        <ChatFoldClamp v-else-if="section.kind === `log`" :lines="section.entries.length">
            <div class="flex min-w-max flex-col py-1 font-mono">
                <div v-for="entry in section.entries" :key="entry.hash" class="flex gap-2 px-2.5 whitespace-nowrap">
                    <span class="shrink-0 text-subtle">{{ entry.hash }}</span>
                    <span class="text-content">{{ entry.text }}</span>
                </div>
            </div>
        </ChatFoldClamp>
        <ChatCodeBody v-else-if="section.lang !== undefined" bare :code="section.text" :lang="section.lang" />
        <ChatFoldClamp v-else :lines="lineCount">
            <pre class="px-2.5 py-1.5 font-mono break-words whitespace-pre-wrap text-content">{{ section.text }}</pre>
        </ChatFoldClamp>
    </div>
</template>
