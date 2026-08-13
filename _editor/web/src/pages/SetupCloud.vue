<script setup lang="ts">
import type { CloudOptions, CloudProvider, SandboxSummary } from "@intentic-app/api-contract";
import { cmp, Notice, type NoticeModel, NoticeStack, Segmented, useDevice } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Select from "primevue/select";
import { computed, onUnmounted, ref, watch } from "vue";
import { track } from "../composables/analytics";
import { apiClient } from "../composables/useApi";
import { CLOUD_PROVIDERS, cloudCredentials, cloudProviderMeta, isCapacityMiss, ORACLE_STEPS, sizeLabel } from "./setupCloud";

/* Step 3's cloud machine form (see setupCloud.ts for what this is). The flow is three moves on one card:
 * pick a provider, paste its credential, confirm the region/size the options call preselected — Create. The
 * options fetch doubles as the credential check (it is the credential's first spend), so a bad paste is named
 * here, before anything exists to pay for. After Create the parent owns the story: the machine's first boot
 * claims the same setup code a pasted command would, so the existing claim → report → announce footer
 * narrates it with no new machinery. */

const { sandboxId } = defineProps<{ sandboxId: string }>();
const emit = defineEmits<{ provisioned: [summary: SandboxSummary] }>();

const { mobile } = useDevice();

// Oracle first — the free 12 GB machine is the ladder's flagship rung, and the picker's order says so.
const provider = ref<CloudProvider>(`oracle`);
const meta = computed(() => cloudProviderMeta(provider.value));
// One buffer per field, not per provider: a token pasted for Hetzner is meaningless to DigitalOcean, so a
// provider switch clears rather than remembers (the same reason the attach lane clears its token on a lane
// switch — a credential must never outlive the context it was pasted for).
const token = ref(``);
const ociConfig = ref(``);
const ociKey = ref(``);
watch(provider, () => {
    token.value = ``;
    ociConfig.value = ``;
    ociKey.value = ``;
});

const credentials = computed(() => cloudCredentials(provider.value, { token: token.value, ociConfig: ociConfig.value, ociKey: ociKey.value }));

// The provider's live catalog for the pasted credential — regions and sizes with real prices, never numbers
// this page hard-coded. Refetched (debounced past paste-then-fix keystrokes) whenever the credential changes;
// a response for a credential no longer in the fields is dropped.
const options = ref<CloudOptions | null>(null);
const optionsLoading = ref(false);
const optionsError = ref<NoticeModel | undefined>(undefined);
const location = ref<string | undefined>(undefined);
const size = ref<string | undefined>(undefined);
let fetchTimer: ReturnType<typeof setTimeout> | undefined;

const fetchOptions = async (): Promise<void> => {
    const asked = credentials.value;
    if (asked === undefined) {
        return;
    }
    optionsLoading.value = true;
    optionsError.value = undefined;
    try {
        const listed = await apiClient.sandbox.cloudOptions({ credentials: asked });
        if (asked !== credentials.value) {
            return;
        }
        options.value = listed;
        location.value = listed.defaultLocation;
        size.value = listed.defaultSize;
    } catch (err) {
        if (asked === credentials.value) {
            optionsError.value = noticeFrom(err, `Couldn't reach ${meta.value.label} with that credential. Try again.`);
        }
    } finally {
        if (asked === credentials.value) {
            optionsLoading.value = false;
        }
    }
};

watch(
    credentials,
    () => {
        clearTimeout(fetchTimer);
        options.value = null;
        optionsError.value = undefined;
        location.value = undefined;
        size.value = undefined;
        if (credentials.value !== undefined) {
            fetchTimer = setTimeout(() => void fetchOptions(), 600);
        }
    },
    { immediate: true },
);

const locationOptions = computed(() => options.value?.locations.map((entry) => ({ label: entry.label, value: entry.id })) ?? []);
const sizeOptions = computed(() => options.value?.sizes.map((entry) => ({ label: sizeLabel(entry), value: entry.id })) ?? []);

const provisioning = ref(false);
const provisionError = ref<NoticeModel | undefined>(undefined);
const ready = computed(() => credentials.value !== undefined && options.value !== null && location.value !== undefined && size.value !== undefined);

/* THE KEEP-TRYING LOOP, for exactly one refusal: Oracle's capacity miss (isCapacityMiss — the adapter already
 * walked every availability domain, so by now it is a matter of WHEN, not where). The credential stays in
 * this component's memory and nowhere else — the retry lives in the browser precisely so the platform never
 * has to hold it — which is also why the offer is honest about its one condition: the tab has to stay open. */
const capacityMiss = ref(false);
const keepTrying = ref(false);
const RETRY_EVERY_MS = 2 * 60_000;
let retryTimer: ReturnType<typeof setInterval> | undefined;
onUnmounted(() => clearInterval(retryTimer));

const create = async (): Promise<void> => {
    const chosen = credentials.value;
    if (chosen === undefined || location.value === undefined || size.value === undefined || provisioning.value) {
        return;
    }
    provisioning.value = true;
    provisionError.value = undefined;
    try {
        const summary = await apiClient.sandbox.cloudProvision({ sandboxId, credentials: chosen, location: location.value, size: size.value });
        // The cloud lane's counterpart of sandbox_command_claimed: a machine now exists that will claim the
        // code on its own — everything after this event is the provider's boot plus Docker's.
        track(`sandbox_cloud_provisioned`, { provider: provider.value, mobile: mobile.value });
        clearInterval(retryTimer);
        keepTrying.value = false;
        emit(`provisioned`, summary);
    } catch (err) {
        track(`sandbox_cloud_provision_failed`, { provider: provider.value });
        provisionError.value = noticeFrom(err, `Couldn't create the machine. Try again.`);
        capacityMiss.value = provider.value === `oracle` && isCapacityMiss(provisionError.value?.title);
        if (!capacityMiss.value) {
            // A refusal that retrying can't fix must not be retried into — the loop is for weather only.
            keepTrying.value = false;
        }
    } finally {
        provisioning.value = false;
    }
};

// The loop itself, below `create` so the reference reads downward: toggled on, it re-presses the button every
// couple of minutes; success (in `create`) and unmount both clear it.
watch(keepTrying, (on) => {
    clearInterval(retryTimer);
    if (on) {
        retryTimer = setInterval(() => void create(), RETRY_EVERY_MS);
    }
});
</script>

<template>
    <div class="flex flex-col gap-3">
        <Segmented v-model="provider" :options="CLOUD_PROVIDERS.map((entry) => ({ label: entry.label, value: entry.id }))" :stretch="mobile" />

        <!-- The credential, with the "get one" link beside the field it fills — the reader who needs it is
             mid-step, and sending them to search the provider's docs is where this flow would lose them. -->
        <template v-if="meta.kind === `token`">
            <label class="ui-field">
                <span class="ui-field-label">API token</span>
                <input
                    v-model="token"
                    type="password"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    :placeholder="`Paste your ${meta.label} API token`"
                    :class="cmp.input('w-full font-mono text-base md:text-sm')"
                />
                <span class="text-xs text-muted">
                    <a :href="meta.credentialUrl" target="_blank" rel="noopener" class="text-link hover:underline">{{ meta.credentialLabel }}</a>
                    is used to create this one machine, and never stored by intentic.
                </span>
            </label>
        </template>
        <template v-else>
            <!-- The walkthrough, click by click: the painful part of the free machine is Oracle's console,
                 so the wizard walks it rather than pointing at docs — each step deep-links the exact screen.
                 NO BOX. Three instructions inside a bordered, darker inset, inside the run card, inside a
                 column, is three frames deep to say "press this, then this" — and the frame made the steps
                 read as a quotation from somewhere else rather than as the thing to do next. The numbers are
                 the structure; they need no walls. -->
            <ol class="flex flex-col gap-2 text-xs text-content">
                <li v-for="(step, index) in ORACLE_STEPS" :key="index" class="flex items-start gap-2.5">
                    <span class="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-overlay text-2xs font-medium text-subtle">
                        {{ index + 1 }}
                    </span>
                    <span class="min-w-0">
                        {{ step.text }}
                        <a v-if="step.url" :href="step.url" target="_blank" rel="noopener" class="text-link hover:underline">{{
                            step.urlLabel
                        }}</a>
                    </span>
                </li>
            </ol>
            <label class="ui-field">
                <span class="ui-field-label">Config snippet</span>
                <textarea
                    v-model="ociConfig"
                    rows="4"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    placeholder="[DEFAULT]&#10;user=ocid1.user.oc1..…&#10;fingerprint=…&#10;tenancy=ocid1.tenancy.oc1..…&#10;region=…"
                    :class="cmp.input('w-full resize-y font-mono text-base md:text-sm')"
                />
            </label>
            <label class="ui-field">
                <span class="ui-field-label">Private key</span>
                <textarea
                    v-model="ociKey"
                    rows="4"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    placeholder="-----BEGIN PRIVATE KEY-----&#10;…"
                    :class="cmp.input('w-full resize-y font-mono text-base md:text-sm')"
                />
                <span class="text-xs text-muted">
                    <a :href="meta.credentialUrl" target="_blank" rel="noopener" class="text-link hover:underline">{{ meta.credentialLabel }}</a>
                    is used to create this one machine, and never stored by intentic.
                </span>
            </label>
        </template>

        <p v-if="optionsLoading" class="flex items-center gap-2 text-xs text-muted">
            <Icon name="spinner" spin class="text-info" />
            Checking the credential and fetching {{ meta.label }}'s regions and prices…
        </p>
        <Notice v-else-if="optionsError" :of="optionsError" />

        <template v-if="options !== null">
            <!-- Stacked on a phone for the same reason the attach lane stacks: side by side, neither pick
                 keeps enough width to read its own label. -->
            <div class="flex flex-col gap-2 md:flex-row">
                <label class="ui-field md:flex-1">
                    <span class="ui-field-label">{{ provider === `oracle` ? `Availability domain` : `Region` }}</span>
                    <Select
                        v-model="location"
                        :options="locationOptions"
                        option-label="label"
                        option-value="value"
                        size="small"
                        class="w-full text-xs"
                    />
                </label>
                <label class="ui-field md:flex-1">
                    <span class="ui-field-label">Size</span>
                    <Select v-model="size" :options="sizeOptions" option-label="label" option-value="value" size="small" class="w-full text-xs" />
                </label>
            </div>

            <Notice v-if="provisionError" :of="provisionError" />
            <!-- The capacity miss's honest offer: the adapter already tried every availability domain, so the
                 fix is time — and the retry runs HERE, in the tab, because that is where the pasted credential
                 lives and the only place it should. -->
            <label v-if="capacityMiss" class="flex items-start gap-2 text-xs text-muted">
                <Checkbox v-model="keepTrying" binary />
                <span class="min-w-0">
                    <span class="text-content">Keep trying while this tab is open</span> — retries every couple of minutes. Your credential stays
                    in this tab and is never stored.
                </span>
            </label>
            <Button
                label="Create the machine"
                class="w-full justify-center md:w-auto md:self-start"
                :loading="provisioning"
                :disabled="provisioning || !ready"
                @click="create"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p class="text-2xs text-subtle">
                Created in your {{ meta.label }} account, so it's yours:
                {{ meta.id === `oracle` ? `free within the Always-Free tier` : `billed by ${meta.label} directly to you` }}, and deleting it happens
                in their console.
            </p>
        </template>
    </div>
</template>
