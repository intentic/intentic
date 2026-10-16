<script setup lang="ts">
import type { PrivacyProvider, PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { RowGroup, SkeletonRows, SkeletonSnapshot, vSkeletonSource } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { allowAdding } from "./privacyShield";
import PrivacyShieldActivity from "./PrivacyShieldActivity.vue";
import { shieldRefusal, usePrivacyLog, usePrivacyShield } from "../../../models/sandbox/usePrivacyShield";

// What the privacy shield did, as Activity's Personal data part: every request it handled, and the values it replaced.
// The settings it reads are the Privacy shield page's; the one write it makes, a value pressed as one to leave alone, is
// the same policy write that page makes, and its refusal is said here, where it was pressed. Until 2026-10-16 this sat at
// the foot of the shield's own settings.

const t = useT();

const { status, setPolicy, saveError } = usePrivacyShield();
const { entries, isLoading, error } = usePrivacyLog();

const policy = computed<PrivacyShieldPolicy | undefined>(() => status.value?.policy);
const providers = computed<readonly PrivacyProvider[]>(() => status.value?.providers ?? []);
const notice = computed(() => shieldRefusal(saveError.value, t(`sandbox.agentPrivacyShield.ownerOnly`), t(`sandbox.agentPrivacyShield.couldntSave`)));

// Added to what is saved, unless the shield already reads it as listed.
const neverMask = (value: string): void => {
    setPolicy((current) => {
        const added = allowAdding(current.allow, value);
        return added.kind === `added` ? { ...current, allow: added.allow } : current;
    });
};
</script>

<template>
    <SkeletonSnapshot v-if="isLoading" of="sandbox.activity.privacy">
        <RowGroup :label="t(`sandbox.agentPrivacyShield.activity`)"><SkeletonRows :rows="3" description /></RowGroup>
    </SkeletonSnapshot>
    <PrivacyShieldActivity
        v-else
        v-skeleton-source="`sandbox.activity.privacy`"
        :entries="entries"
        :providers="providers"
        :policy="policy"
        :ready="policy !== undefined"
        :error="error"
        :notice="notice"
        @never-mask="neverMask"
    />
</template>
