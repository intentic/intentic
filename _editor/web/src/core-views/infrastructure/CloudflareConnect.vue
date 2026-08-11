<script setup lang="ts">
import { cmp, InfoHint, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref } from "vue";
import CloudflareTokenField from "../../components/CloudflareTokenField.vue";
import { CF_TOKEN_KEY, useCloudflareZones } from "../../composables/extensions/useCloudflareZones";
import { useInventory } from "../../composables/extensions/useInventory";
import { useSecretKeys, useSecrets } from "../../composables/secrets/useSecrets";

/* The reusable "Connect Cloudflare" step. Collects a Cloudflare API token (unless the sandbox already has
 * one) plus the zone it manages, writes CLOUDFLARE_API_TOKEN to the sandbox .env and declares the
 * i.have.cloudflare("cf") backend with the chosen zone persisted on it, then emits `connected`. Used inline
 * by the Add service dialog and the Connections page so neither dead-ends the user into a separate flow. */

const emit = defineEmits<{ connected: [] }>();

const cf = useCloudflareZones();
const { cfToken, cfTokenValid, selectedZone } = cf;
const { set: setSecret } = useSecrets();
const { hasKey } = useSecretKeys();
const { add } = useInventory();

// The sandbox may already carry a Cloudflare token (own-Cloudflare onboarding seeds it) — then all that's
// missing is the backend declaration; we can't re-list zones since we only know the key exists, not its value.
const tokenAlreadySet = computed(() => hasKey(CF_TOKEN_KEY));
const submitting = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

const canConnect = computed(() => tokenAlreadySet.value || (cfTokenValid.value && selectedZone.value !== undefined));

const connect = async (): Promise<void> => {
    if (!canConnect.value || submitting.value) {
        return;
    }
    submitting.value = true;
    error.value = undefined;
    try {
        if (!tokenAlreadySet.value) {
            await setSecret.mutateAsync({ key: CF_TOKEN_KEY, value: cfToken.value.trim() });
        }
        // The zone rides on the entry (i.have.cloudflare("cf", { zone })), so resolve validates against it
        // without re-discovering it from the token — and the Add-service dialog can offer `<subdomain>.<zone>`
        // in every later session. The tokenAlreadySet path can't list zones, so it declares without one.
        await add.mutateAsync({
            kind: `backend`,
            provider: `cloudflare`,
            name: `cf`,
            values: selectedZone.value !== undefined ? { zone: selectedZone.value } : {},
        });
        emit(`connected`);
    } catch (err) {
        error.value = noticeFrom(err, `Could not connect Cloudflare.`);
    } finally {
        submitting.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <Notice v-if="error" :of="error" />

        <!-- Token already in the sandbox: just declare the backend. -->
        <template v-if="tokenAlreadySet">
            <p class="text-sm text-muted">Your sandbox already has a Cloudflare token. Enable it so this service can be reached on your domain.</p>
            <div class="flex items-center justify-between gap-3">
                <RouterLink to="/sandbox/secrets" class="text-xs text-link hover:underline">Replace the token in Sandbox Secrets</RouterLink>
                <Button label="Enable Cloudflare" :loading="submitting" @click="connect">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
        </template>

        <!-- No token yet: collect token + zone, then write it to the sandbox and declare the backend. -->
        <form v-else class="flex flex-col gap-3" @submit.prevent="connect">
            <div class="flex items-center gap-2.5">
                <h3 class="text-sm font-semibold text-content">Connect Cloudflare</h3>
                <InfoHint class="ml-auto" label="Why the Cloudflare API token is required">
                    <p class="mb-1 text-sm font-semibold text-content">Why this token?</p>
                    <p class="mb-3 text-2xs leading-relaxed text-muted">
                        Your service is put on your domain through a Cloudflare tunnel — no open inbound ports.
                    </p>
                    <ul class="flex flex-col gap-2 text-2xs text-muted">
                        <li class="flex items-start gap-2">
                            <Icon name="bolt" class="mt-0.5 text-link" />
                            <span>Creates the tunnel and DNS route for your service</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <Icon name="lock" class="mt-0.5 text-success" />
                            <span
                                ><span class="text-content">Stored only in your sandbox</span> — used once here to list zones, never on the
                                platform</span
                            >
                        </li>
                    </ul>
                </InfoHint>
            </div>
            <CloudflareTokenField
                :cf="cf"
                storage-note="Used once to look up your Cloudflare zones, then stored in your sandbox — never on the platform."
            >
                <template #zone-confirmed>
                    <p v-if="cf.zones.value.length === 1 && selectedZone" class="text-xs text-success">
                        ✓ Using <span class="font-mono">{{ selectedZone }}</span>
                    </p>
                </template>
            </CloudflareTokenField>

            <div class="flex justify-end">
                <Button type="submit" label="Connect Cloudflare" :disabled="!canConnect || submitting" :loading="submitting">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
        </form>
    </div>
</template>
