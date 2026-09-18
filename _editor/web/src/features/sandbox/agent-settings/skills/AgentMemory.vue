<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { MarkdownDocument, Notice, RowGroup, RowNote } from "@intentic/ui";
import { onMounted } from "vue";
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
        <RowNote variant="block">
            <Notice v-if="editorError" :of="editorError" />

            <div class="ui-field-shell mt-3 max-h-[60dvh] overflow-auto p-3" style="--prose-measure: 72ch">
                <MarkdownDocument
                    v-model="draft"
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
                    class="min-h-48"
                    @save="commit"
                >
                    <template #note
                        ><code>{{ MEMORY_FILE }}</code
                        >{{ t(`sandbox.agentMemory.atWorkspaceRoot`) }}</template
                    >
                </MarkdownDocument>
            </div>
        </RowNote>
    </RowGroup>
</template>
