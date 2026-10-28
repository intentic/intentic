<script setup lang="ts">
import { Button, ConfirmDialog, Icon, iconForEntry } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { computed, onBeforeUnmount } from "vue";
import { type ConflictChoice, conflictQuestion, holdConflictAsker } from "./moveConflicts";

// Asks how a move lands where its names are taken (moveConflicts.ts), once for the whole gesture. Keep both is the
// step asked for, since it loses nothing; Replace and Skip are the alternatives beside it; Cancel moves nothing.
// Mounted once per page that moves files, which is what lets the question be asked at all.

const t = useT();
onBeforeUnmount(holdConflictAsker());

const question = computed(() => conflictQuestion.value);
const header = computed(() => {
    const names = question.value?.names ?? [];
    const folder = question.value?.dir === `` ? t(`workspace.moveConflict.theWorkspace`) : basename(question.value?.dir ?? ``);
    return names.length === 1
        ? t(`workspace.moveConflict.oneTaken`, { name: names[0] ?? ``, folder })
        : t(`workspace.moveConflict.manyTaken`, { count: names.length, folder });
});
const answer = (choice: ConflictChoice | undefined): void => question.value?.answer(choice);
</script>

<template>
    <ConfirmDialog
        :open="question !== undefined"
        :header="header"
        :description="question?.names.length === 1 ? t(`workspace.moveConflict.oneDescription`) : t(`workspace.moveConflict.manyDescription`)"
        size="md"
        :confirm-label="t(`workspace.moveConflict.keepBoth`)"
        confirm-icon="clone"
        :destructive="false"
        :items="(question?.names.length ?? 0) > 1 ? question?.names : []"
        @cancel="answer(undefined)"
        @confirm="answer(`keep`)"
    >
        <template #item="{ item }">
            <Icon :name="iconForEntry(item, `file`)" class="shrink-0 text-xs text-muted" />
            <span class="truncate text-content">{{ item }}</span>
        </template>
        <template #actions>
            <Button v-if="question?.others === true" tier="boring" :label="t(`workspace.moveConflict.skip`)" @click="answer(`skip`)" />
            <Button tier="boring" tone="danger" :label="t(`workspace.moveConflict.replace`)" @click="answer(`replace`)" />
        </template>
    </ConfirmDialog>
</template>
