<script setup lang="ts">
import { Button, RowGroup, RowNote } from "@intentic/ui";
import { RouterLink } from "vue-router";
import { useSandboxBackup } from "./useSandboxBackup";
import { useT } from "@intentic/ui/i18n";

// Offers desktop sync where it is the difference between one copy of this work and two: a cloud machine, read from
// the app on a computer that could hold the second copy. Not a warning — nothing is broken — and not dismissible,
// because turning sync on is what makes it go away, and it is one tab from here.

const t = useT();
const { unbacked } = useSandboxBackup();
</script>

<template>
    <RowGroup v-if="unbacked" :label="t(`sandbox.sandboxBackupCard.heading`)">
        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <p class="text-xs text-muted">{{ t(`sandbox.sandboxBackupCard.detail`) }}</p>
                <div class="flex flex-wrap items-center gap-2">
                    <RouterLink to="/sandbox/devices">
                        <Button :label="t(`sandbox.sandboxBackupCard.turnOnSync`)" size="small">
                            <template #icon><Icon name="desktop" /></template>
                        </Button>
                    </RouterLink>
                    <span class="text-2xs text-subtle">{{ t(`sandbox.sandboxBackupCard.whatSyncDoes`) }}</span>
                </div>
            </div>
        </RowNote>
    </RowGroup>
</template>
