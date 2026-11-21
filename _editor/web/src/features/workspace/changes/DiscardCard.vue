<script setup lang="ts">
import { ConfirmDialog } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { DiscardTarget } from "./discardTarget";
import { alsoDeletesLine } from "./scratchWords";

// The question a discard asks before it runs: tracked and untracked outcomes reported separately, scratch folders by
// size. `disabled` holds the confirm while another action, or a discard in the same repo, is running.

const t = useT();
defineProps<{ target: DiscardTarget | undefined; disabled: boolean }>();
defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
    <ConfirmDialog
        :open="target !== undefined"
        :header="t(`workspace.reviewPanel.discardChanges`)"
        :confirm-label="target?.verb ?? t(`ui.action.discard`)"
        :confirm-disabled="disabled"
        @cancel="$emit('cancel')"
        @confirm="$emit('confirm')"
    >
        <!-- The question can name a long path, which wraps rather than running out of the box. -->
        <template #description>
            <span class="break-words">{{ target?.question }}</span>
        </template>
        <div v-if="target" class="flex flex-col gap-3">
            <!-- The counts are a floor when daemon truncation hides additional files. -->
            <p v-if="target.partial" class="text-warning">
                {{ t(`workspace.reviewPanel.moreFilesPendingHere`) }}
            </p>
            <!-- The verb agrees with the count (`plural`), since a lone file misreading as plural is the one line here that must be read carefully. -->
            <p v-if="target.restores > 0" class="text-muted">
                {{ target.partial ? t(`workspace.words.atLeast`) : `` }}
                {{ t(`workspace.reviewPanel.filesReturn`, { count: target.restores }, target.restores) }}
            </p>
            <div v-if="target.deletes.length > 0">
                <p class="text-danger">
                    {{ target.partial ? t(`workspace.words.atLeast`) : `` }}
                    {{ t(`workspace.reviewPanel.untrackedLeave`, { count: target.deletes.length }, target.deletes.length) }}
                </p>
                <ul class="mt-1 max-h-24 overflow-auto">
                    <li v-for="path in target.deletes" :key="path" class="truncate font-mono text-2xs text-muted" dir="rtl">
                        <bdi>{{ path }}</bdi>
                    </li>
                </ul>
            </div>
            <p v-if="alsoDeletesLine(target.folders)" class="text-danger">{{ alsoDeletesLine(target.folders) }}</p>
            <p class="text-2xs text-subtle">
                <Icon name="shield" class="mr-0.5 text-[0.6rem]" />{{ t(`workspace.reviewPanel.restorePointSavedFirst2`) }}
            </p>
        </div>
    </ConfirmDialog>
</template>
