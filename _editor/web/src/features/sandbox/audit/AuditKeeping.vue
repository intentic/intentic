<script setup lang="ts">
import type { AuditSettings } from "@intentic/sandbox-contract/schemas/data-protection";
import { Notice, Picker, Row, RowGroup, RowNote, toneInk } from "@intentic/ui";
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

// The address is always HTTPS (the daemon refuses anything else), so the scheme is printed in front of the box rather
// than typed into it: the box holds the rest. A whole address pasted in folds its `https://` into that prefix as it
// lands; any other scheme stays in the box and is refused by name on commit. Empty stops forwarding.
const SCHEME = `https://`;
const SCHEME_AT_START = /^\s*https:\/\//iu;
const OTHER_SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;
const urlRest = computed(() => (audit.value?.forwardUrl ?? ``).replace(SCHEME_AT_START, ``));
// What is typed and not yet saved. Kept apart from the saved address so a refused one stays in the box beside its
// reason: Vue writes a bound `value` back on every render, and the error's own render would put the old address back.
const draft = ref<string>();
const urlError = ref<string>();
const URL_ERROR_ID = `audit-forward-url-error`;
const foldScheme = (event: Event): void => {
    // SAFETY: bound only to the address <input> below, whose input event targets that input.
    const input = event.target as HTMLInputElement;
    urlError.value = undefined;
    if (SCHEME_AT_START.test(input.value)) {
        input.value = input.value.replace(SCHEME_AT_START, ``);
    }
    draft.value = input.value;
};
const commitUrl = (event: Event): void => {
    // SAFETY: bound only to the address <input> below, whose change event targets that input.
    const rest = (event.target as HTMLInputElement).value.trim().replace(SCHEME_AT_START, ``);
    const value = rest === `` ? `` : `${SCHEME}${rest}`;
    const valid = value === `` || (!OTHER_SCHEME.test(rest) && URL.canParse(value) && new URL(value).hostname !== ``);
    urlError.value = valid ? undefined : t(`sandbox.sandboxAudit.forwardUrlInvalid`);
    if (valid) {
        draft.value = undefined;
        if (value !== audit.value?.forwardUrl) {
            setAudit({ forwardUrl: value });
        }
    }
};
// Escape puts the saved address back and drops what was typed.
const revertUrl = (): void => {
    draft.value = undefined;
    urlError.value = undefined;
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

// How the copies are getting there, once there is somewhere to send them: a line under the two rows, its glyph in the
// rows' own column.
const forwardingLine = computed(() => {
    const forwarding = status.value?.forwarding;
    if (forwarding === undefined) {
        return undefined;
    }
    if (forwarding.lastError !== undefined) {
        return {
            tone: `danger` as const,
            icon: `exclamation-triangle` as const,
            text: t(`sandbox.sandboxAudit.forwardFailing`, { error: forwarding.lastError, count: forwarding.pending }),
        };
    }
    return forwarding.pending === 0
        ? { tone: `success` as const, icon: `check-circle` as const, text: t(`sandbox.sandboxAudit.forwardUpToDate`) }
        : {
              tone: `warning` as const,
              icon: `clock` as const,
              text: t(`sandbox.sandboxAudit.forwardPending`, { count: forwarding.pending }, forwarding.pending),
          };
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
        <!-- The address is the row's control, as every other setting on the page is: an empty box is "off". A refused address
             takes the description's place, so the row stays the height it was and the reason sits beside the box. -->
        <Row icon="external-link" :title="t(`sandbox.sandboxAudit.forwardTitle`)">
            <template #description>
                <span v-if="urlError !== undefined" :id="URL_ERROR_ID" :class="toneInk(`danger`)">{{ urlError }}</span>
                <template v-else>{{ t(`sandbox.sandboxAudit.forwardDescription`) }}</template>
            </template>
            <template #control>
                <!-- The shell is the frame and takes the focus; the scheme is printed, never typed. -->
                <label
                    class="ui-field-shell flex w-72 max-w-full cursor-text items-center overflow-hidden px-2 py-1 font-mono text-base md:text-xs"
                    :class="urlError === undefined ? `` : `ui-field-error-box`"
                >
                    <span class="-my-1 -ml-2 mr-2 flex shrink-0 select-none items-center self-stretch border-r border-line bg-overlay px-2 text-muted" aria-hidden="true">{{
                        SCHEME
                    }}</span>
                    <input
                        type="text"
                        inputmode="url"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        :value="draft ?? urlRest"
                        :disabled="audit === undefined"
                        :aria-label="t(`sandbox.sandboxAudit.forwardUrlLabel`)"
                        :aria-invalid="urlError !== undefined"
                        :aria-describedby="urlError === undefined ? undefined : URL_ERROR_ID"
                        :placeholder="t(`sandbox.sandboxAudit.forwardUrlPlaceholder`)"
                        class="field-bare min-w-0 flex-1 truncate md:text-xs"
                        @input="foldScheme"
                        @change="commitUrl"
                        @keydown.esc="revertUrl"
                    />
                </label>
            </template>
        </Row>
        <Row icon="key" :title="t(`sandbox.sandboxAudit.forwardSecretLabel`)" :description="t(`sandbox.sandboxAudit.forwardSecretHint`)">
            <template #control>
                <Picker
                    :model-value="audit?.forwardSecret === `` || audit === undefined ? NO_SECRET : audit.forwardSecret"
                    :options="secretOptions"
                    :disabled="audit === undefined || audit.forwardUrl === ``"
                    :aria-label="t(`sandbox.sandboxAudit.forwardSecretLabel`)"
                    class="ui-field-sm w-72 max-w-full justify-between md:text-xs"
                    @update:model-value="pickSecret"
                />
            </template>
        </Row>
        <RowNote v-if="forwardingLine !== undefined" :icon="forwardingLine.icon" :tone="forwardingLine.tone">{{ forwardingLine.text }}</RowNote>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
