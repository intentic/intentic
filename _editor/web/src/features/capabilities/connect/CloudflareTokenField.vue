<script setup lang="ts">
import { ui, Notice, type NoticeModel, Picker, type PickerOption } from "@intentic/ui";
import { computed } from "vue";
import { CF_TOKEN_KEY, type useCloudflareZones } from "../../extensions/useCloudflareZones";
import SecretField from "./SecretField.vue";

// Shared token+zone flow between the setup wizard and the in-app Connect step, so the format warning and scopes
// list live once. `storageNote` differs per caller (write to .env vs. never stored); `cf` carries the whole
// composable's state since each caller owns its own token and zone.

const { cf } = defineProps<{ cf: ReturnType<typeof useCloudflareZones>; storageNote: string }>();

// Zones are domains, shown as a filterable picker of monospace rows since a token can carry dozens.
const zonesNotice = computed<NoticeModel | undefined>(() =>
    cf.zonesError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your Cloudflare zones.`, detail: cf.zonesError.value },
);
const zoneOptions = computed<PickerOption[]>(() => cf.zones.value.map((zone) => ({ value: zone, label: zone, icon: `globe`, mono: true })));

// Bridges SecretField's v-model onto the composable's setter, which drives the debounced zone lookup.
const token = computed({ get: () => cf.cfToken.value, set: cf.setToken });
</script>

<template>
    <label class="ui-field">
        <span class="ui-field-label">API token</span>
        <SecretField v-model="token" :secret-key="CF_TOKEN_KEY" collect no-hint placeholder="Paste your Cloudflare API token" />
    </label>

    <p v-if="cf.cfToken.value.length === 0" class="text-xs text-muted">{{ storageNote }}</p>
    <p v-else-if="!cf.cfTokenValid.value" class="text-xs text-warning">
        That doesn't look like a Cloudflare API token. Double-check for copy/paste slips.
    </p>
    <p v-else-if="cf.zonesLoading.value" class="text-xs text-muted">
        <Icon name="spinner" spin /> Checking which Cloudflare zones this token can use…
    </p>
    <Notice v-else-if="zonesNotice" :of="zonesNotice" />
    <label v-else-if="cf.zones.value.length > 1" class="ui-field">
        <span class="ui-field-label">Cloudflare zone</span>
        <Picker
            v-model="cf.selectedZone.value"
            :options="zoneOptions"
            placeholder="Pick the domain to use"
            class="w-full"
            aria-label="Cloudflare zone"
        />
        <span class="text-xs text-muted">This token can reach several domains. Choose which one to use.</span>
    </label>
    <!--
        Confirms the zone even with only one, since a token might resolve to a domain other than the one the user
        expected.
    -->
    <slot name="zone-confirmed" />

    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-link hover:underline"
        >
            Create a token <Icon name="external-link" />
        </a>
        <span class="text-subtle">Scopes: Zone:Read · DNS:Edit · Cloudflare Tunnel:Edit</span>
    </div>
</template>
