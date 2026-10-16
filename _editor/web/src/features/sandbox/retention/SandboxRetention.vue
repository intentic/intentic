<script setup lang="ts">
import {
    AUDIT_RETENTION_DAYS_DEFAULT,
    AUDIT_RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    type RetentionSettings,
    RetentionSettingsSchema,
} from "@intentic/sandbox-contract/schemas/data-protection";
import { type IconName, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { commitCount } from "../agent-settings/models/numberInputs";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";

// Retention: how long this sandbox keeps each kind of record, in one table, so "how long do we keep it" has one answer.
// The copies of what people and agents wrote (settings.retention) were Agent ▸ Finishing, beside the archive row, and
// the audit trail's period was Audit log ▸ How it is kept, until 2026-10-16. They differ in one thing said on the rows:
// every copy starts at forever (0) and deletes once a number is set, while the audit trail is always kept for a period,
// at least a month, since a trail that could be switched off records nothing.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();

const retention = computed((): RetentionSettings => settings.value?.retention ?? RetentionSettingsSchema.parse({}));
const auditDays = computed(() => settings.value?.audit.retentionDays ?? AUDIT_RETENTION_DAYS_DEFAULT);

type Kind = keyof RetentionSettings;

// Built in a computed, not a table at import: `t` reads the active language when it is called.
const ROWS = computed((): { key: Kind; icon: IconName; title: string; description: string }[] => [
    { key: `transcriptDays`, icon: `comments`, title: t(`sandbox.retention.transcripts`), description: t(`sandbox.retention.transcriptsNote`) },
    { key: `restorePointDays`, icon: `history`, title: t(`sandbox.retention.restorePoints`), description: t(`sandbox.retention.restorePointsNote`) },
    { key: `privacyVaultDays`, icon: `eye-slash`, title: t(`sandbox.retention.privacyVault`), description: t(`sandbox.retention.privacyVaultNote`) },
    { key: `cacheDays`, icon: `image`, title: t(`sandbox.retention.caches`), description: t(`sandbox.retention.cachesNote`) },
    { key: `rawOutputDays`, icon: `align-left`, title: t(`sandbox.retention.rawOutput`), description: t(`sandbox.retention.rawOutputNote`) },
]);

// An emptied or odd field clamps to the schema's bounds, and the box shows what was kept, so it never holds a number
// the save would refuse.
const COPY = { min: 0, max: RETENTION_DAYS_MAX };
const AUDIT = { min: AUDIT_RETENTION_DAYS_MIN, max: RETENTION_DAYS_MAX };
const setDays = (key: Kind, event: Event): void =>
    commitCount(event, retention.value[key], COPY, (days) => patch({ retention: { ...retention.value, [key]: days } }));
const setAuditDays = (event: Event): void => {
    const audit = settings.value?.audit;
    if (audit !== undefined) {
        commitCount(event, audit.retentionDays, AUDIT, (retentionDays) => patch({ audit: { ...audit, retentionDays } }));
    }
};
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <RowGroup :label="t(`sandbox.retention.title`)">
            <RowNote>{{ t(`sandbox.retention.intro`) }}</RowNote>
            <Row v-for="row in ROWS" :key="row.key" :icon="row.icon" :title="row.title" :description="row.description">
                <template #control>
                    <span class="flex items-center gap-2">
                        <input
                            type="number"
                            :min="COPY.min"
                            :max="COPY.max"
                            :aria-label="row.title"
                            :class="ui.input({ size: `sm` }, 'w-20 text-right')"
                            :value="retention[row.key]"
                            :disabled="settings === undefined"
                            @change="setDays(row.key, $event)"
                        />
                        <span class="whitespace-nowrap text-sm text-muted">{{
                            retention[row.key] === 0 ? t(`sandbox.retention.forever`) : t(`sandbox.retention.days`)
                        }}</span>
                    </span>
                </template>
            </Row>
            <!-- Last, and unlike the rows above never forever: the record of who changed what is kept for a period whatever is set. -->
            <Row icon="list-check" :title="t(`sandbox.retention.audit`)" :description="t(`sandbox.retention.auditNote`)">
                <template #control>
                    <span class="flex items-center gap-2">
                        <input
                            type="number"
                            :min="AUDIT.min"
                            :max="AUDIT.max"
                            :aria-label="t(`sandbox.retention.audit`)"
                            :class="ui.input({ size: `sm` }, 'w-20 text-right')"
                            :value="auditDays"
                            :disabled="settings === undefined"
                            @change="setAuditDays"
                        />
                        <span class="whitespace-nowrap text-sm text-muted">{{ t(`sandbox.retention.days`) }}</span>
                    </span>
                </template>
            </Row>
            <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
        </RowGroup>
    </div>
</template>
