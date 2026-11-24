<script setup lang="ts">
import { MEMORY_MAX_CHARS } from "@intentic/constants";
import { formatCompact, formatCount, Icon, MarkdownDocument, Notice } from "@intentic/ui";
import { computed, onMounted, watch } from "vue";
import MemoryGauge from "./MemoryGauge.vue";
import { memoryFolderOf } from "./memorySide";
import { useMemoryDocument } from "./useMemoryDocument";
import { useMemoryFiles } from "./useMemoryFiles";
import { useT } from "@intentic/ui/i18n";

// One memory file as a page: a tab of the side panel beside whatever section is open (SideMemory.vue), a sheet over
// Settings on a phone (AgentMemory). Written where it is read, saved on an explicit press. Above it, the two facts the
// document cannot say about itself: which turns read it, and how much of their room for memory it takes. A missing file
// opens empty, and its first save makes it.

const t = useT();

const { path, host = `side` } = defineProps<{
    /** Root-relative. Fixed for the page's life: a tab is keyed by it. */
    path: string;
    /** What holds the page: a side tab scrolls on its own and titles it; a sheet has its own title bar and scroller. */
    host?: `side` | `sheet`;
}>();

const emit = defineEmits<{
    /** Something was typed that is not saved yet: a host that replaces what it shows on the next open should keep this. */
    edited: [];
}>();

const { draft, onDisk, saving, error, edited, load, commit } = useMemoryDocument(path);
const { byPath } = useMemoryFiles();

const folder = memoryFolderOf(path);
const file = computed(() => byPath.value.get(path));
// What the tree says the file costs, or, before it has been written, what is typed.
const size = computed(() => file.value?.size ?? draft.value.length);
const share = computed(() => (size.value / MEMORY_MAX_CHARS) * 100);
const dropped = computed(() => file.value?.dropped === true);

onMounted(() => void load());
// Changed under the page (an import, the Workspace's editor, a rule approved in chat): read again.
watch(
    () => file.value?.mtime,
    (now, before) => {
        if (now !== undefined && before !== undefined && now !== before) {
            void load();
        }
    },
);
watch(edited, (now) => {
    if (now) {
        emit(`edited`);
    }
});
</script>

<template>
    <!-- Its own scroller only as a side tab: in a sheet the sheet's body scrolls. -->
    <div class="@container" :class="host === `side` ? `h-full overflow-y-auto` : ``">
        <div class="mx-auto flex max-w-4xl flex-col gap-4" :class="host === `side` ? `px-5 py-4` : ``">
            <header class="flex items-center gap-3">
                <div class="min-w-0 flex-1">
                    <h1 v-if="host === `side`" class="truncate font-mono text-lg font-semibold text-content">{{ path }}</h1>
                    <p class="flex items-center gap-1.5 text-xs text-muted">
                        <Icon :name="folder === `` ? `home` : `folder`" class="text-2xs" aria-hidden="true" />
                        <span class="truncate">{{
                            folder === `` ? t(`sandbox.agentMemory.everyTurn`) : t(`sandbox.agentMemory.turnsInsideFolder`, { folder })
                        }}</span>
                    </p>
                </div>
                <!-- The gauge the chip wore, with the numbers it stands for. -->
                <span class="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted tabular-nums">
                    <MemoryGauge :share="share" :dropped="dropped" />
                    {{ formatCompact(size) }} / {{ formatCompact(MEMORY_MAX_CHARS) }}
                </span>
            </header>

            <!-- The one failure a memory file has: present, and not read. Said first. -->
            <Notice v-if="dropped" tone="danger">{{ t(`sandbox.agentMemory.leftOutDetail`, { max: formatCount(MEMORY_MAX_CHARS) }) }}</Notice>
            <Notice v-if="error !== undefined" :of="error" />

            <MarkdownDocument
                v-model="draft"
                :editable="onDisk !== undefined"
                :stored="onDisk"
                :saving="saving"
                save="explicit"
                :max-chars="MEMORY_MAX_CHARS"
                :label="path"
                :placeholder="
                    onDisk === undefined
                        ? t(`ui.status.reading`)
                        : folder === ``
                          ? t(`sandbox.agentMemory.writeForEveryTurn`)
                          : t(`sandbox.agentMemory.writeForFolder`, { folder })
                "
                @save="commit"
            />
        </div>
    </div>
</template>
