<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { lockedFile } from "./lockedFile";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The refusal used to arrive as a flicker: a tab appeared, the read came back empty, the tab closed. */

const { path } = defineProps<{ path: string }>();

const locked = computed(() => lockedFile(path));
</script>

<template>
    <EmptyState icon="lock" :line="t(`workspace.fileLocked.holdsCantOpenedEdited`, { holds: locked.holds })" class="h-full">
        <template #title>
            <span class="font-semibold">{{ locked.subject }}</span> {{ t(`workspace.fileLocked.keptPrivateBySandbox`) }}
        </template>
        <template v-if="locked.manage" #actions>
            <Button :as="RouterLink" :to="locked.manage.to" tier="boring">
                {{ t(`ui.action.open`) }} {{ locked.manage.label }}
                <Icon name="arrow-right" class="text-xs" />
            </Button>
        </template>
    </EmptyState>
</template>
