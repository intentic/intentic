<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { Button, MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { computed, onMounted } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useAgentMemory } from "./useAgentMemory";
import { useT } from "@intentic/ui/i18n";

// One file, read at the top of every turn on every runtime; this group can read, edit and delete it, not just append
// via import. Save is explicit since a half-typed sentence going live would be read on the next turn.

const t = useT();

const { draft, onDisk, present, saving, editorError, load, commit } = useAgentMemory();
const router = useRouter();

// Read, and not there: "Open file" on a file that doesn't exist landed on the workspace root with nothing open, so the
// action makes it first, from what the editor holds, and then opens it.
const missing = computed(() => onDisk.value !== undefined && !present.value);
const createAndOpen = async (): Promise<void> => {
    await commit(draft.value);
    if (editorError.value === undefined) {
        await router.push(`/workspace/${MEMORY_FILE}`);
    }
};

onMounted(() => void load());
</script>

<template>
    <RowGroup :label="t(`sandbox.agentMemory.memory`)">
        <!-- The group's card IS the page: a document wrapped in a field shell reads as a hole punched in the section. -->
        <template #actions>
            <!-- Where a long edit goes: the same file, in the editor that gives it the whole pane; made first when missing. -->
            <Button
                v-if="missing"
                :label="t(`sandbox.agentMemory.createFile`)"
                size="small"
                severity="secondary"
                :text="true"
                :loading="saving"
                @click="createAndOpen"
            >
                <template #icon><Icon name="plus" /></template>
            </Button>
            <Button
                v-else
                :as="RouterLink"
                :to="`/workspace/${MEMORY_FILE}`"
                :label="t(`sandbox.agentMemory.openFile`)"
                size="small"
                severity="secondary"
                :text="true"
            >
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </template>

        <RowNote v-if="editorError" variant="block"><Notice :of="editorError" /></RowNote>

        <MarkdownDocument
            v-model="draft"
            frame="section"
            :editable="onDisk !== undefined"
            :stored="onDisk"
            :saving="saving"
            save="explicit"
            :label="MEMORY_FILE"
            :placeholder="
                onDisk === undefined
                    ? t(`sandbox.agentMemory.reading`, { memory_file: MEMORY_FILE })
                    : t(`sandbox.agentMemory.nothingHereYetWhat`)
            "
            @save="commit"
        >
            <template #note
                ><code>{{ MEMORY_FILE }}</code
                >{{ missing ? t(`sandbox.agentMemory.notCreatedYet`) : t(`sandbox.agentMemory.atWorkspaceRoot`) }}</template
            >
        </MarkdownDocument>
    </RowGroup>
</template>
