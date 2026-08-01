<script setup lang="ts">
import { cmp, Picker, type PickerOption } from "@intentic-app/ui";
import { computed } from "vue";
import { CF_TOKEN_KEY, type useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import SecretField from "./SecretField.vue";

/* PASTE A CLOUDFLARE TOKEN, PICK A ZONE — the acquisition half of every Cloudflare flow, and the part the
 * setup wizard and the in-app "Connect Cloudflare" step had each written out.
 *
 * The STATE was already shared (useCloudflareZones); the 45 lines that render it were not, down to identical
 * warning copy ("That doesn't look like a Cloudflare API token — double-check for copy/paste slips") and an
 * identical footer naming the three scopes. A token-format warning that exists twice is one a fix reaches
 * once, and the scopes line is exactly the kind of string that goes stale in one copy the day Cloudflare
 * renames a permission.
 *
 * THE LADDER IS THE POINT, and it is why this is a component rather than a snippet. Between an empty box and a
 * usable zone there are five states — nothing typed, malformed, looking up, the lookup failed, and more than
 * one zone to choose from — and each has to say something different. A caller that reimplements four of them
 * and forgets the fifth leaves a screen that just sits there.
 *
 * `storageNote` is a prop rather than fixed text because the two callers genuinely differ in what becomes of
 * the token: the in-app step WRITES it to the sandbox's .env, while the wizard lets it ride the install
 * command and never stores it anywhere. That is the one sentence a reader is owed and the one thing these two
 * flows do not share.
 *
 * The composable's whole binding set arrives as ONE prop. It is a factory, not a singleton — each caller holds
 * its own token and zone — so the state has to come from the parent, and threading its seven refs through
 * seven props would put six chances to mis-wire between a token and the zones it discovered. */

const { cf } = defineProps<{ cf: ReturnType<typeof useCloudflareZones>; storageNote: string }>();

// Zones are domains — monospace rows behind a filterable picker, since an account-wide token can carry dozens.
const zoneOptions = computed<PickerOption[]>(() => cf.zones.value.map((zone) => ({ value: zone, label: zone, icon: `globe`, mono: true })));

// Bridges SecretField's v-model onto the composable's setter, which is what drives the debounced zone lookup.
const token = computed({ get: () => cf.cfToken.value, set: cf.setToken });
</script>

<template>
    <label class="ui-field">
        <span class="ui-field-label">API token</span>
        <SecretField v-model="token" :secret-key="CF_TOKEN_KEY" collect no-hint placeholder="Paste your Cloudflare API token" />
    </label>

    <p v-if="cf.cfToken.value.length === 0" class="text-xs text-muted">{{ storageNote }}</p>
    <p v-else-if="!cf.cfTokenValid.value" class="text-xs text-warning">
        That doesn't look like a Cloudflare API token — double-check for copy/paste slips.
    </p>
    <p v-else-if="cf.zonesLoading.value" class="text-xs text-muted">
        <Icon name="spinner" spin /> Checking which Cloudflare zones this token can use…
    </p>
    <div v-else-if="cf.zonesError.value" :class="cmp.alertDanger('text-2xs')">{{ cf.zonesError.value }}</div>
    <label v-else-if="cf.zones.value.length > 1" class="ui-field">
        <span class="ui-field-label">Cloudflare zone</span>
        <Picker v-model="cf.selectedZone.value" :options="zoneOptions" placeholder="Pick the domain to use" class="w-full" aria-label="Cloudflare zone" />
        <span class="text-xs text-muted">This token can reach several domains — choose which one to use.</span>
    </label>
    <!-- The one-zone case still confirms WHICH, because a token that sees a different domain than the user
         expected is the failure this flow cannot otherwise surface until the tunnel is already built. -->
    <slot name="zone-confirmed" />

    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs">
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
