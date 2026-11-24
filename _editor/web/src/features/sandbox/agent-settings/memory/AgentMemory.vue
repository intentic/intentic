<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { Button, Card, Icon, Modal, Section, useDevice } from "@intentic/ui";
import { ref } from "vue";
import { sideDocked } from "../../../../workbench/side/sideTabs";
import { revealSideView } from "../../../../workbench/side/sideViews";
import MemoryChip from "./MemoryChip.vue";
import MemoryImport from "./MemoryImport.vue";
import MemoryPage from "./MemoryPage.vue";
import { MEMORY_SIDE_VIEW, memorySideInput } from "./memorySide";
import { useMemoryFiles } from "./useMemoryFiles";
import { useT } from "@intentic/ui/i18n";

// What the agent remembers, as the files it reads it from: the workspace's own AGENTS.md, which every turn reads, and
// each folder's, read by the turns that start inside it, each a name on a pill with a gauge of how much of a turn's room
// for memory it takes. A press opens the file's page beside this section (the side panel's memory view, SideMemory.vue),
// written where it is read; a phone, with no side panel, opens it as a sheet here. Bringing memory over from another
// assistant is a dialog of its own, behind the section's quiet action.

const t = useT();

const { root, folders, loaded } = useMemoryFiles();
const { mobile } = useDevice();

// The page a phone shows over this list, since it has no side panel to put one in.
const sheet = ref<string | undefined>();
const importing = ref(false);

// A file not written yet is opened kept: it is being written, and the next press elsewhere must not throw it away.
const open = (path: string, fresh = false): void => {
    if (sideDocked.value && !mobile.value) {
        revealSideView(MEMORY_SIDE_VIEW, memorySideInput(path), { keep: fresh });
        return;
    }
    sheet.value = path;
};

// What was brought over, shown where it landed.
const imported = (): void => open(MEMORY_FILE);
</script>

<template>
    <Section data-setting="agent-memory" :label="t(`sandbox.agentMemory.memory`)">
        <template #actions>
            <Button size="small" tier="quiet" :label="t(`sandbox.agentMemory.import`)" v-tooltip.top="{ title: t(`sandbox.agentMemory.bringMemoryOver`) }" @click="importing = true">
                <template #icon><Icon name="download" /></template>
            </Button>
            <Button v-if="loaded && root === undefined" size="small" tier="boring" :label="t(`sandbox.agentMemory.write`)" @click="open(MEMORY_FILE, true)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <!-- One surface, a label beside its names, as the skills above it read. -->
        <Card>
            <dl class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5 @xl:flex-row @xl:gap-3">
                    <dt class="text-xs text-subtle @xl:w-32 @xl:shrink-0 @xl:pt-1.5">{{ t(`sandbox.agentMemory.everyTurn`) }}</dt>
                    <dd class="flex min-w-0 flex-wrap gap-1.5">
                        <MemoryChip v-if="root !== undefined" :file="root" @open="open(root.path)" />
                        <span v-else-if="loaded" class="text-xs text-muted @xl:pt-1.5">{{ t(`sandbox.agentMemory.nothingYet`) }}</span>
                        <span v-else class="h-6.5 w-28 animate-pulse rounded-full bg-content/5" role="status" :aria-label="t(`ui.status.reading`)" />
                    </dd>
                </div>
                <div v-if="folders.length > 0" class="flex flex-col gap-1.5 @xl:flex-row @xl:gap-3">
                    <dt class="text-xs text-subtle @xl:w-32 @xl:shrink-0 @xl:pt-1.5">{{ t(`sandbox.agentMemory.turnsInside`) }}</dt>
                    <dd class="flex min-w-0 flex-wrap gap-1.5">
                        <MemoryChip v-for="file in folders" :key="file.path" :file="file" @open="open(file.path)" />
                    </dd>
                </div>
            </dl>
        </Card>
    </Section>

    <MemoryImport v-model:open="importing" @imported="imported" />

    <Modal :open="sheet !== undefined" size="full" :header="sheet" @update:open="(value: boolean) => !value && (sheet = undefined)">
        <MemoryPage v-if="sheet !== undefined" :key="sheet" :path="sheet" host="sheet" />
    </Modal>
</template>
