<script setup lang="ts">
import { ui, Notice, type NoticeModel, Picker, type PickerOption } from "@intentic/ui";
import { computed } from "vue";
import { CF_TOKEN_KEY, type useCloudflareZones } from "../../extensions/useCloudflareZones";
import SecretField from "./SecretField.vue";
import { useT } from "@intentic/ui/i18n";

// Shared token+zone flow between the setup wizard and the in-app Connect step, so the format warning and scopes
// list live once. `storageNote` differs per caller (write to .env vs. never stored); `cf` carries the whole
// composable's state since each caller owns its own token and zone.

const t = useT();

const { cf } = defineProps<{ cf: ReturnType<typeof useCloudflareZones>; storageNote: string }>();

// Zones are domains, shown as a filterable picker of monospace rows since a token can carry dozens.
const zonesNotice = computed<NoticeModel | undefined>(() =>
    cf.zonesError.value === undefined
        ? undefined
        : { tone: `danger`, title: t(`capabilities.cloudflareTokenField.couldntReadCloudflareZones`), detail: cf.zonesError.value },
);
const zoneOptions = computed<PickerOption[]>(() => cf.zones.value.map((zone) => ({ value: zone, label: zone, icon: `globe`, mono: true })));

// Bridges SecretField's v-model onto the composable's setter, which drives the debounced zone lookup.
const token = computed({ get: () => cf.cfToken.value, set: cf.setToken });
</script>

<template>
    <label class="ui-field">
        <span class="ui-field-label">{{ t(`capabilities.cloudflareTokenField.apiToken`) }}</span>
        <SecretField
            v-model="token"
            :secret-key="CF_TOKEN_KEY"
            collect
            no-hint
            :placeholder="t(`capabilities.cloudflareTokenField.pasteCloudflareApiToken`)"
        />
    </label>

    <p v-if="cf.cfToken.value.length === 0" class="text-xs text-muted">{{ storageNote }}</p>
    <p v-else-if="!cf.cfTokenValid.value" class="text-xs text-warning">
        {{ t(`capabilities.cloudflareTokenField.doesntLookLikeCloudflare`) }}
    </p>
    <p v-else-if="cf.zonesLoading.value" class="text-xs text-muted">
        <Icon name="spinner" spin /> {{ t(`capabilities.cloudflareTokenField.checkingCloudflareZonesToken`) }}
    </p>
    <Notice v-else-if="zonesNotice" :of="zonesNotice" />
    <label v-else-if="cf.zones.value.length > 1" class="ui-field">
        <span class="ui-field-label">{{ t(`capabilities.cloudflareTokenField.cloudflareZone`) }}</span>
        <Picker
            v-model="cf.selectedZone.value"
            :options="zoneOptions"
            :placeholder="t(`capabilities.cloudflareTokenField.pickDomainToUse`)"
            class="w-full"
            :aria-label="t(`capabilities.cloudflareTokenField.cloudflareZone`)"
        />
        <span class="text-xs text-muted">{{ t(`capabilities.cloudflareTokenField.tokenReachSeveralDomains`) }}</span>
    </label>
    <!-- Confirms the zone even with only one, since a token might resolve to a domain other than the one the user expected. -->
    <slot name="zone-confirmed" />

    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-link hover:underline"
        >
            {{ t(`capabilities.cloudflareTokenField.createToken`) }} <Icon name="external-link" />
        </a>
        <span class="text-subtle">{{ t(`capabilities.cloudflareTokenField.scopesZoneReadDns`) }}</span>
    </div>
</template>
