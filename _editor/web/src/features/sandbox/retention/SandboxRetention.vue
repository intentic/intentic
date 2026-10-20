<script setup lang="ts">
import {
    AUDIT_RETENTION_DAYS_DEFAULT,
    AUDIT_RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    type RetentionSettings,
    RetentionSettingsSchema,
} from "@intentic/sandbox-contract/schemas/data-protection";
import { Await, type IconName, InfoHint, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { commitCount } from "../agent-settings/models/numberInputs";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import AuditKeeping from "../audit/AuditKeeping.vue";

// Retention: how long this sandbox keeps each kind of record, in one table, so "how long do we keep it" has one answer.
// The copies of what people and agents wrote (settings.retention) were Agent ▸ Finishing, beside the archive row, and
// the audit trail's period was Audit log ▸ How it is kept, until 2026-10-16. They differ in one thing said on the rows:
// restore points start at 30 days, other copies at forever (0), and positive periods delete, while the audit trail is always kept for a period,
// at least a month, since a trail that could be switched off records nothing. Below the table, the rest of how the audit
// trail is kept (whether reads are recorded, where a copy goes), which was the audit log's second part until 2026-10-17:
// the log is a part of Activity now, the records alone, and every setting about keeping a record is here.

const t = useT();
const { settings, loaded, patch, refusal } = useSandboxSettings();

const retention = computed((): RetentionSettings => settings.value?.retention ?? RetentionSettingsSchema.parse({}));
const auditDays = computed(() => settings.value?.audit.retentionDays ?? AUDIT_RETENTION_DAYS_DEFAULT);

type Kind = keyof RetentionSettings;

// Built in a computed, not a table at import: `t` reads the active language when it is called.
const ROWS = computed((): { key: Kind; icon: IconName; title: string; description: string }[] => [
    { key: `transcriptDays`, icon: `comments`, title: t(`sandbox.retention.transcripts`), description: t(`sandbox.retention.transcriptsNote`) },
    { key: `restorePointKeepDays`, icon: `history`, title: t(`sandbox.retention.restorePoints`), description: t(`sandbox.retention.restorePointsNote`) },
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
// The unit after each box. A fixed width, so "forever" on one row and "days" on the next leave the boxes in one column.
const UNIT = `w-16 shrink-0 whitespace-nowrap text-xs text-muted`;
const setAuditDays = (event: Event): void => {
    const audit = settings.value?.audit;
    if (audit !== undefined) {
        commitCount(event, audit.retentionDays, AUDIT, (retentionDays) => patch({ audit: { ...audit, retentionDays } }));
    }
};
</script>

<template>
    <!-- The numbers are the sandbox's own or nothing: never the schema's defaults standing in for a read that has not
         answered, or that failed (the page showed "0 · forever" for every record under a failing read). -->
    <Await :of="loaded">
        <div class="@container flex flex-col gap-6">
            <RowGroup data-setting="retention-periods" :label="t(`sandbox.retention.title`)">
                <!-- How the numbers work, and the exceptions each row's one line leaves out: reference, so it sits behind the (i)
                     and the rows stay one line each. -->
                <template #info>
                    <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.retention.title`) })">
                        <span class="flex flex-col gap-2 text-xs text-content">
                            <span>{{ t(`sandbox.retention.intro`) }}</span>
                            <span class="flex flex-col gap-1 border-t border-line-subtle pt-2 text-muted">
                                <span>{{ t(`sandbox.retention.introTranscripts`) }}</span>
                                <span>{{ t(`sandbox.retention.introPrivacyVault`) }}</span>
                                <span>{{ t(`sandbox.retention.introCaches`) }}</span>
                                <span>{{ t(`sandbox.retention.introAudit`) }}</span>
                            </span>
                        </span>
                    </InfoHint>
                </template>
                <Row v-for="row in ROWS" :key="row.key" :icon="row.icon" :title="row.title" :description="row.description">
                    <template #control>
                        <span class="flex items-center gap-2">
                            <input
                                type="number"
                                inputmode="numeric"
                                :min="COPY.min"
                                :max="COPY.max"
                                :aria-label="row.title"
                                :class="ui.input({ size: `sm` }, 'w-20 text-right tabular-nums')"
                                :value="retention[row.key]"
                                :disabled="settings === undefined"
                                @change="setDays(row.key, $event)"
                            />
                            <!-- One width whatever it says, so every box above and below starts at the same x. -->
                            <span :class="UNIT">{{ retention[row.key] === 0 ? t(`sandbox.retention.forever`) : t(`sandbox.retention.days`) }}</span>
                        </span>
                    </template>
                </Row>
                <!-- Last, and unlike the rows above never forever: the record of who changed what is kept for a period whatever is set. -->
                <Row icon="list-check" :title="t(`sandbox.retention.audit`)" :description="t(`sandbox.retention.auditNote`)">
                    <template #control>
                        <span class="flex items-center gap-2">
                            <input
                                type="number"
                                inputmode="numeric"
                                :min="AUDIT.min"
                                :max="AUDIT.max"
                                :aria-label="t(`sandbox.retention.audit`)"
                                :class="ui.input({ size: `sm` }, 'w-20 text-right tabular-nums')"
                                :value="auditDays"
                                :disabled="settings === undefined"
                                @change="setAuditDays"
                            />
                            <span :class="UNIT">{{ t(`sandbox.retention.days`) }}</span>
                        </span>
                    </template>
                </Row>
                <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
            </RowGroup>

            <AuditKeeping />
        </div>
    </Await>
</template>
