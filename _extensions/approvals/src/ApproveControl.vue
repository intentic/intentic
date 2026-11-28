<!-- A waiting item's approve buttons. (2026-11-28) When its filer asked for a passkey (`cosign`), an offered one adds
"Approve with passkey" beside Approve, and a required one makes it the only approve (passkeyApprove.ts). -->
<script setup lang="ts">
import type { ApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import { Button, Icon } from "@intentic/extension-ui";
import { computed } from "vue";
import { passkeyCosignOf } from "./passkeyApprove";
import { t } from "./i18n.js";

const { item, label, disabled } = defineProps<{ item: ApprovalSummary; label: string; disabled: boolean }>();
const emit = defineEmits<{ approve: []; passkey: [] }>();

const cosign = computed(() => passkeyCosignOf(item));
// The main button approves with the passkey when the filer required one, else plainly.
const press = (): void => (cosign.value === `required` ? emit(`passkey`) : emit(`approve`));
</script>

<template>
    <Button
        v-if="cosign === `offered`"
        :label="t(`approvalsView.approveWithPasskey`)"
        :aria-label="t(`approvalsView.approveWithPasskeyItem`, { item: label })"
        size="small"
        tier="boring"
        :disabled="disabled"
        @click="emit(`passkey`)"
    >
        <template #icon><Icon name="key" /></template>
    </Button>
    <Button
        :label="cosign === `required` ? t(`approvalsView.approveWithPasskey`) : t(`approvalsView.approve`)"
        size="small"
        tier="accent"
        :disabled="disabled"
        @click="press"
    >
        <template #icon><Icon :name="cosign === `required` ? `key` : `check`" /></template>
    </Button>
</template>
