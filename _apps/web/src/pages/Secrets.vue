<script setup lang="ts">
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { cmp, Page, Segmented, StatusBadge } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import SecretEntryRow from "../components/SecretEntryRow.vue";
import SecretField from "../components/SecretField.vue";
import SecretGroup from "../components/SecretGroup.vue";
import { readIntenticLines } from "../composables/intenticStream";
import { sandboxRequest } from "../composables/sandbox/sandboxClient";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useSecretInventory } from "../composables/extensions/useSecrets";

/* The one place every secret is visible: what the intent requires (and which resources use it), what's set,
 * what intentic generated, which capability credentials are connected, and whether the CI copy is current.
 * One dense surface, one line per secret, details on disclosure — so it stays readable from a handful of
 * secrets to dozens. Values stay in the sandbox — the only value-returning action is the owner-only reveal. */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const { inventory, inventoryPending, refreshInventory } = useSecretInventory();
const { capabilities } = useCapabilities();
const router = useRouter();

// DevOps scaffolds the desired-state repo the env/generated secrets live in; until its capability reports
// `active`, those groups are empty and every /secrets write 412s — so gate them on this signal (state, not
// mere presence: a scaffolding devops sits at `pending`).
const devopsActive = computed(() => capabilities.value.some((entry) => entry.kind === `devops` && entry.status.state === `active`));

const required = computed(() => inventory.value.filter((entry) => entry.kind === `env` && entry.requiredBy.length > 0));
const yours = computed(() => inventory.value.filter((entry) => entry.kind === `env` && entry.requiredBy.length === 0));
const generated = computed(() => inventory.value.filter((entry) => entry.kind === `generated`));
const capabilityEntries = computed(() => inventory.value.filter((entry) => entry.kind === `capability`));
const providers = computed(() => inventory.value.filter((entry) => entry.kind === `provider`));
const missingCount = computed(() => inventory.value.filter((entry) => entry.status === `missing` && entry.kind === `env`).length);

// Filter + scope keep the view readable as the secret count grows.
const filter = ref(``);
const scope = ref<`all` | `missing`>(`all`);
const scopeOptions = computed(() => [
    { label: `All`, value: `all` as const },
    { label: `Missing`, value: `missing` as const, badge: missingCount.value },
]);
const q = computed(() => filter.value.trim().toLowerCase());
const filtering = computed(() => q.value !== `` || scope.value !== `all`);
const applyFilter = (list: SecretInventoryEntry[]): SecretInventoryEntry[] =>
    list.filter(
        (entry) =>
            (q.value === `` || entry.key.toLowerCase().includes(q.value) || (entry.label?.toLowerCase().includes(q.value) ?? false)) &&
            (scope.value === `all` || entry.status === `missing`),
    );
const requiredF = computed(() => applyFilter(required.value));
const yoursF = computed(() => applyFilter(yours.value));
const generatedF = computed(() => applyFilter(generated.value));
const capabilitiesF = computed(() => applyFilter(capabilityEntries.value));
const providersF = computed(() => applyFilter(providers.value));
// Empty groups keep their informative note at rest, but drop out entirely while filtering.
const groupVisible = (list: SecretInventoryEntry[]): boolean => !filtering.value || list.length > 0;
const countSummary = (list: SecretInventoryEntry[]): string | undefined => {
    const set = list.filter((entry) => entry.status === `set`).length;
    const connected = list.filter((entry) => entry.status === `connected`).length;
    const missing = list.filter((entry) => entry.status === `missing`).length;
    const parts = [
        set > 0 ? `${set} set` : undefined,
        connected > 0 ? `${connected} connected` : undefined,
        missing > 0 ? `${missing} missing` : undefined,
    ].filter((part) => part !== undefined);
    return parts.length > 0 ? parts.join(` · `) : undefined;
};

// Add-a-secret (any env key the user wants available at apply time); collapsed until invoked.
const adding = ref(false);
const newKey = ref(``);
const newKeyValid = computed(() => KEY_RE.test(newKey.value));
const cancelAdd = (): void => {
    adding.value = false;
    newKey.value = ``;
};

// CI sync: once adopt recorded a push, stale entries get the "Push to CI" action (streams `intentic secrets push`).
const ciStale = computed(() => inventory.value.some((entry) => entry.ci !== undefined && !entry.ci.synced));
const ciKnown = computed(() => inventory.value.some((entry) => entry.ci !== undefined));
const pushing = ref(false);
const pushError = ref<string | undefined>(undefined);
const pushToCi = async (): Promise<void> => {
    pushing.value = true;
    pushError.value = undefined;
    try {
        const response = await sandboxRequest(`/intentic`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ args: [`secrets`, `push`] }),
        });
        if (!response.ok || !response.body) {
            throw new Error(`Could not push secrets to CI (${response.status}).`);
        }
        for await (const line of readIntenticLines(response.body)) {
            if (line[`kind`] === `error` && typeof line[`message`] === `string`) {
                throw new Error(line[`message`]);
            }
        }
        refreshInventory();
    } catch (err) {
        pushError.value = err instanceof Error ? err.message : `Could not push secrets to CI.`;
    } finally {
        pushing.value = false;
    }
};
</script>

<template>
    <Page>
        <header class="mb-4">
            <h1 class="text-2xl font-semibold">Secrets</h1>
            <p class="mt-1 text-sm text-muted">
                Everything lives inside your sandbox — the platform never sees a value. Your intent declares which secrets it needs; intentic
                generates the rest.
            </p>
        </header>

        <div v-if="missingCount > 0" :class="cmp.alertWarning('mb-4')">
            {{ missingCount }} required secret{{ missingCount === 1 ? ` is` : `s are` }} not set yet — deploys fail until every required value is in
            place.
        </div>
        <div v-if="pushError" :class="cmp.alertDanger('mb-4')">{{ pushError }}</div>

        <div v-if="inventoryPending" :class="cmp.emptyState('py-6')"><Icon name="spinner" spin /> Reading your sandbox's secrets…</div>

        <template v-else>
            <!-- Until DevOps scaffolds the desired-state repo, the env/generated groups don't exist and writes fail. -->
            <RouterLink
                v-if="!devopsActive"
                to="/capabilities"
                :class="cmp.alertWarning('mb-4 flex items-center gap-2 no-underline transition-colors hover:border-warning')"
            >
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span>Managing secrets needs DevOps active.</span>
                <span class="ml-auto inline-flex items-center gap-1 font-medium">Activate <Icon name="arrow-right" class="text-2xs" /></span>
            </RouterLink>

            <!-- Toolbar: filter by key, scope to missing, and push the whole set to CI. -->
            <div class="mb-3 flex flex-wrap items-center gap-2">
                <div class="relative min-w-0 flex-1">
                    <Icon
                        name="search"
                        aria-hidden="true"
                        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                    />
                    <input
                        v-model="filter"
                        type="text"
                        placeholder="Filter secrets…"
                        autocapitalize="off"
                        spellcheck="false"
                        :class="cmp.input('w-full min-w-0 py-1.5 pl-8 pr-8')"
                        @keydown.esc="filter = ``"
                    />
                    <button
                        v-if="filter"
                        type="button"
                        aria-label="Clear filter"
                        title="Clear (Esc)"
                        class="absolute right-2 top-1/2 -translate-y-1/2 rounded text-2xs text-subtle transition-colors hover:text-content"
                        @click="filter = ``"
                    >
                        <Icon name="times" />
                    </button>
                </div>
                <Segmented v-model="scope" :options="scopeOptions" />
                <Button
                    v-if="ciKnown"
                    :label="ciStale ? `Push to CI` : `CI in sync`"
                    size="small"
                    :severity="ciStale ? undefined : `secondary`"
                    :disabled="!ciStale"
                    :loading="pushing"
                    @click="pushToCi"
                >
                    <template #icon><Icon :name="ciStale ? `cloud-upload` : `check`" /></template>
                </Button>
            </div>

            <!-- One dense surface: every group is a slim header over its rows, separated by hairlines. -->
            <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
                <SecretGroup
                    v-if="devopsActive && groupVisible(requiredF)"
                    icon="key"
                    label="Required by your intent"
                    :count="countSummary(requiredF)"
                >
                    <p v-if="requiredF.length === 0" class="px-4 py-2.5 text-xs text-subtle">Your intent declares no user-supplied secrets yet.</p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in requiredF" :key="entry.key" :entry="entry" editable />
                    </div>
                </SecretGroup>

                <SecretGroup v-if="devopsActive && groupVisible(yoursF)" icon="plus-circle" label="Your secrets" :count="countSummary(yoursF)">
                    <div v-if="yoursF.length > 0" class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in yoursF" :key="entry.key" :entry="entry" editable removable />
                    </div>
                    <div v-if="!filtering" class="px-4 py-2.5">
                        <button
                            v-if="!adding"
                            type="button"
                            class="flex items-center gap-2 text-xs text-muted transition-colors hover:text-content"
                            @click="adding = true"
                        >
                            <Icon name="plus" class="text-2xs" /> Add a secret
                        </button>
                        <div v-else class="flex flex-col gap-2">
                            <div class="flex items-start gap-2">
                                <input
                                    v-model="newKey"
                                    placeholder="KEY_NAME"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    :class="cmp.input('w-44 shrink-0 font-mono')"
                                />
                                <SecretField class="flex-1" :secret-key="newKey" :disabled="!newKeyValid" no-hint @saved="newKey = ``" />
                            </div>
                            <span v-if="newKey.length > 0 && !newKeyValid" class="text-2xs text-warning">
                                Letters, digits and underscores; must not start with a digit.
                            </span>
                            <button type="button" class="self-start text-2xs text-subtle transition-colors hover:text-content" @click="cancelAdd">
                                Cancel
                            </button>
                        </div>
                    </div>
                </SecretGroup>

                <SecretGroup
                    v-if="devopsActive && groupVisible(generatedF)"
                    icon="sparkles"
                    label="Generated by intentic"
                    :count="countSummary(generatedF)"
                >
                    <p v-if="generatedF.length === 0" class="px-4 py-2.5 text-xs text-subtle">
                        Nothing generated yet — these appear after your first deploy.
                    </p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in generatedF" :key="entry.key" :entry="entry" />
                    </div>
                </SecretGroup>

                <SecretGroup v-if="groupVisible(capabilitiesF)" icon="th-large" label="Capability credentials" :count="countSummary(capabilitiesF)">
                    <template #actions>
                        <RouterLink to="/capabilities"><Button label="Manage capabilities" size="small" severity="secondary" /></RouterLink>
                    </template>
                    <p v-if="capabilitiesF.length === 0" class="px-4 py-2.5 text-xs text-subtle">No credentialed capabilities connected.</p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in capabilitiesF" :key="entry.key" :entry="entry" editable />
                    </div>
                </SecretGroup>

                <SecretGroup v-if="groupVisible(providersF)" icon="comments" label="AI providers" :count="countSummary(providersF)">
                    <template #actions>
                        <Button label="Manage accounts" size="small" severity="secondary" @click="router.push('/sandbox/agent')" />
                    </template>
                    <p v-if="providersF.length === 0" class="px-4 py-2.5 text-xs text-subtle">No AI provider accounts connected.</p>
                    <div v-else class="flex flex-wrap gap-2 px-4 pb-3 pt-3">
                        <StatusBadge
                            v-for="entry in providersF"
                            :key="entry.key"
                            :variant="entry.status === `connected` ? `success` : `neutral`"
                            size="sm"
                            dot
                        >
                            {{ entry.label ?? entry.key }}
                        </StatusBadge>
                    </div>
                </SecretGroup>
            </div>
        </template>
    </Page>
</template>
