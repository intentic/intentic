<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { Button, MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { onMounted } from "vue";
import { RouterLink } from "vue-router";
import { useAgentMemory } from "./useAgentMemory";
import { useT } from "@intentic/ui/i18n";

// One file, read at the top of every turn on every runtime; this group can read, edit and delete it, not just append
// via import. Save is explicit since a half-typed sentence going live would be read on the next turn.

const t = useT();

const { draft, onDisk, saving, editorError, load, commit } = useAgentMemory();

onMounted(() => void load());
</script>

<template>
    <RowGroup :label="t(`sandbox.agentMemory.memory`)">
        <!-- The group's card IS the page: a document wrapped in a field shell reads as a hole punched in the section. -->
        <template #actions>
            <!-- Where a long edit goes: the same file, in the editor that gives it the whole pane. -->
            <Button
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
                >{{ t(`sandbox.agentMemory.atWorkspaceRoot`) }}</template
            >
        </MarkdownDocument>
    </RowGroup>
</template>
