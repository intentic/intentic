<script setup lang="ts">
import type { AuditSettings } from "@intentic/sandbox-contract/schemas/data-protection";
import { Notice, Picker, Row, RowGroup, RowNote, toneInk, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useSecretInventory } from "../../../models/capabilities/useSecrets";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { useAuditStatus } from "./useAudit";

// How the audit trail is kept, apart from how long: whether reads are recorded too, and where a copy is sent that
// nobody inside the sandbox can change. Drawn on Retention, under the period, so every setting about how a record is
// kept is on one page; it was the audit log's second part, "How it is kept", until 2026-10-17, when the log became a part
// of Activity and stayed the records alone.

const t = useT();
const { settings, patch, refusal } = useSandboxSettings();
const audit = computed<AuditSettings | undefined>(() => settings.value?.audit);
const status = useAuditStatus();

const setAudit = (fields: Partial<AuditSettings>): void => {
    if (audit.value !== undefined) {
        patch({ audit: { ...audit.value, ...fields } });
    }
};

// An address is saved only once it is one the daemon would take: HTTPS, or empty to stop forwarding.
const urlError = ref<string>();
const commitUrl = (event: Event): void => {
    // SAFETY: bound only to the URL <input> below, whose change event targets that input.
    const value = (event.target as HTMLInputElement).value.trim();
    const valid = value === `` || (URL.canParse(value) && new URL(value).protocol === `https:`);
    urlError.value = valid ? undefined : t(`sandbox.sandboxAudit.forwardUrlInvalid`);
    if (valid && value !== audit.value?.forwardUrl) {
        setAudit({ forwardUrl: value });
    }
};

// Only secrets someone stored by name can carry the token; a connection's own credential is not offered.
const { inventory } = useSecretInventory();
const NO_SECRET = `__none__`;
const secretOptions = computed(() => [
    { value: NO_SECRET, label: t(`sandbox.sandboxAudit.forwardSecretNone`) },
    ...inventory.value
        .filter((entry) => (entry.kind === `env` || entry.kind === `generated`) && entry.status === `set`)
        .map((entry) => ({ value: entry.key, label: entry.key })),
]);
const pickSecret = (value: string | undefined): void => {
    if (value !== undefined) {
        setAudit({ forwardSecret: value === NO_SECRET ? `` : value });
    }
};

const forwardingLine = computed(() => {
    const forwarding = status.value?.forwarding;
    if (forwarding === undefined) {
        return undefined;
    }
    if (forwarding.lastError !== undefined) {
        return {
            tone: `danger` as const,
            text: t(`sandbox.sandboxAudit.forwardFailing`, { error: forwarding.lastError, count: forwarding.pending }),
        };
    }
    return forwarding.pending === 0
        ? { tone: `success` as const, text: t(`sandbox.sandboxAudit.forwardUpToDate`) }
        : { tone: `warning` as const, text: t(`sandbox.sandboxAudit.forwardPending`, { count: forwarding.pending }, forwarding.pending) };
});
</script>

<template>
    <RowGroup data-setting="retention-audit" :label="t(`sandbox.retention.auditKeeping`)">
        <Row icon="eye" :title="t(`sandbox.sandboxAudit.readsTitle`)" :description="t(`sandbox.sandboxAudit.readsDescription`)">
            <template #control>
                <ToggleSwitch
                    :model-value="audit?.recordReads ?? false"
                    :disabled="audit === undefined"
                    :aria-label="t(`sandbox.sandboxAudit.readsTitle`)"
                    @update:model-value="(value: boolean) => setAudit({ recordReads: value })"
                />
            </template>
        </Row>
        <Row icon="external-link" :title="t(`sandbox.sandboxAudit.forwardTitle`)" :description="t(`sandbox.sandboxAudit.forwardDescription`)">
            <template #below>
                <div class="flex max-w-2xl flex-col gap-3">
                    <div class="ui-field">
                        <label class="ui-field-label" for="audit-forward-url">{{ t(`sandbox.sandboxAudit.forwardUrlLabel`) }}</label>
                        <input
                            id="audit-forward-url"
                            type="url"
                            :value="audit?.forwardUrl ?? ``"
                            :disabled="audit === undefined"
                            :class="ui.input()"
                            placeholder="https://"
                            @change="commitUrl"
                        />
                        <span v-if="urlError !== undefined" class="ui-field-error">{{ urlError }}</span>
                    </div>
                    <div class="ui-field">
                        <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.forwardSecretLabel`) }}</span>
                        <Picker
                            :model-value="audit?.forwardSecret === `` || audit === undefined ? NO_SECRET : audit.forwardSecret"
                            :options="secretOptions"
                            :disabled="audit === undefined || audit.forwardUrl === ``"
                            :aria-label="t(`sandbox.sandboxAudit.forwardSecretLabel`)"
                            class="w-72 justify-between text-xs"
                            @update:model-value="pickSecret"
                        />
                        <span class="text-2xs text-muted">{{ t(`sandbox.sandboxAudit.forwardSecretHint`) }}</span>
                    </div>
                    <p v-if="forwardingLine !== undefined" class="text-xs" :class="toneInk(forwardingLine.tone)">{{ forwardingLine.text }}</p>
                </div>
            </template>
        </Row>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
