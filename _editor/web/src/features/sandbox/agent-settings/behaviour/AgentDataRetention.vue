<script setup lang="ts">
import { RETENTION_DAYS_MAX, type RetentionSettings, RetentionSettingsSchema } from "@intentic/sandbox-contract";
import { type IconName, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";

// How long the sandbox keeps each kind of copy of what people and agents wrote (settings.retention), for a sandbox
// run under a data protection officer's rules. Beside the archive row in Finished work on purpose: archiving only puts
// a card away, these delete. Every value is 0 (keep forever) unless someone sets one, so the group says plainly what a
// number above 0 does before anyone types one.

const t = useT();

// Its own instance, so a refused save is said under this group rather than under Finished work.
const { settings, patch, refusal } = useSandboxSettings();

const retention = computed((): RetentionSettings => settings.value?.retention ?? RetentionSettingsSchema.parse({}));

type Kind = keyof RetentionSettings;

// Built in a computed, not a table at import: `t` reads the active language when it is called.
const ROWS = computed((): { key: Kind; icon: IconName; title: string; description: string }[] => [
    { key: `transcriptDays`, icon: `comments`, title: t(`sandbox.agentDataRetention.transcripts`), description: t(`sandbox.agentDataRetention.transcriptsNote`) },
    { key: `restorePointDays`, icon: `history`, title: t(`sandbox.agentDataRetention.restorePoints`), description: t(`sandbox.agentDataRetention.restorePointsNote`) },
    { key: `privacyVaultDays`, icon: `shield`, title: t(`sandbox.agentDataRetention.privacyVault`), description: t(`sandbox.agentDataRetention.privacyVaultNote`) },
    { key: `cacheDays`, icon: `image`, title: t(`sandbox.agentDataRetention.caches`), description: t(`sandbox.agentDataRetention.cachesNote`) },
    { key: `rawOutputDays`, icon: `align-left`, title: t(`sandbox.agentDataRetention.rawOutput`), description: t(`sandbox.agentDataRetention.rawOutputNote`) },
]);

// An emptied or odd field clamps to the schema's bounds, and the box shows what was kept, so it never holds a number
// the save would refuse.
const setDays = (key: Kind) => (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const days = Math.min(RETENTION_DAYS_MAX, Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(days);
    patch({ retention: { ...retention.value, [key]: days } });
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentDataRetention.title`)" equal-rows>
        <RowNote>{{ t(`sandbox.agentDataRetention.intro`) }}</RowNote>
        <Row v-for="row in ROWS" :key="row.key" :icon="row.icon" :title="row.title" :description="row.description">
            <template #control>
                <span class="flex items-center gap-2">
                    <input
                        type="number"
                        min="0"
                        :max="RETENTION_DAYS_MAX"
                        :aria-label="row.title"
                        class="ui-field-box ui-field-sm w-20 text-right"
                        :value="retention[row.key]"
                        :disabled="settings === undefined"
                        @change="setDays(row.key)($event)"
                    />
                    <span class="text-sm text-[var(--muted-foreground)] whitespace-nowrap">{{
                        retention[row.key] === 0 ? t(`sandbox.agentDataRetention.forever`) : t(`sandbox.agentDataRetention.days`)
                    }}</span>
                </span>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
