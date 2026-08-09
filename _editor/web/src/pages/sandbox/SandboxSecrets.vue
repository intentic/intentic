<script setup lang="ts">
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { cmp, Notice, type NoticeModel, RowGroup, SearchBar, Segmented, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import SecretEntryRow from "../../components/SecretEntryRow.vue";
import SecretField from "../../components/SecretField.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { readIntenticLines } from "../../composables/intenticStream";
import { sandboxRequest } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { useSecretInventory } from "../../composables/secrets/useSecrets";
import { noticeFrom } from "../../composables/useAsyncAction";

/* The one place every secret is visible: what the intent requires (and which resources use it), what's set,
 * what intentic generated, which capability credentials are connected, and whether the CI copy is current.
 * One dense surface, one line per secret, details on disclosure — so it stays readable from a handful of
 * secrets to dozens. Values stay in the sandbox — the only value-returning action is the owner-only reveal. */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const { inventory, inventoryPending, missingRequiredCount, refreshInventory } = useSecretInventory();
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

// Filter + scope keep the view readable as the secret count grows.
const filter = ref(``);
const scope = ref<`all` | `missing`>(`all`);
const scopeOptions = computed(() => [
    { label: `All`, value: `all` as const },
    { label: `Missing`, value: `missing` as const, badge: missingRequiredCount.value },
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

// CI sync: once adopt recorded a push, stale entries get the "Push to CI" action (streams `intentic deploy secrets push`).
const ciStale = computed(() => inventory.value.some((entry) => entry.ci !== undefined && !entry.ci.synced));
const ciKnown = computed(() => inventory.value.some((entry) => entry.ci !== undefined));
const pushing = ref(false);
const pushError = ref<NoticeModel | undefined>(undefined);
const pushToCi = async (): Promise<void> => {
    pushing.value = true;
    pushError.value = undefined;
    try {
        const response = await sandboxRequest(`/intentic`, jsonBody(`POST`, { args: [`deploy`, `secrets`, `push`] }));
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
        pushError.value = noticeFrom(err, `Could not push secrets to CI.`);
    } finally {
        pushing.value = false;
    }
};
</script>

<template>
    <div>
        <div v-if="missingRequiredCount > 0" :class="cmp.alertWarning('mb-4')">
            {{ missingRequiredCount }} required secret{{ missingRequiredCount === 1 ? ` is` : `s are` }} not set yet — deploys fail until every
            required value is in place.
        </div>
        <Notice v-if="pushError" :of="pushError" class="mb-4" />

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
                <SearchBar
                    v-model="filter"
                    variant="field"
                    clearable
                    aria-label="Filter secrets"
                    placeholder="Filter secrets…"
                    autocapitalize="off"
                    spellcheck="false"
                    class="min-w-0 flex-1"
                />
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

            <!-- Each secret class is its own grouped surface (RowGroup), consistent with the rest of the app;
                 SecretEntryRow keeps the dense, hairline-divided one-line-per-secret body. -->
            <div class="flex flex-col gap-6">
                <RowGroup v-if="devopsActive && groupVisible(requiredF)" label="Required by your intent" :count="countSummary(requiredF)">
                    <p v-if="requiredF.length === 0" class="px-4 py-2.5 text-xs text-subtle">Your intent declares no user-supplied secrets yet.</p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in requiredF" :key="entry.key" :entry="entry" editable />
                    </div>
                </RowGroup>

                <RowGroup v-if="devopsActive && groupVisible(yoursF)" label="Your secrets" :count="countSummary(yoursF)">
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
                </RowGroup>

                <RowGroup v-if="devopsActive && groupVisible(generatedF)" label="Generated by intentic" :count="countSummary(generatedF)">
                    <p v-if="generatedF.length === 0" class="px-4 py-2.5 text-xs text-subtle">
                        Nothing generated yet — these appear after your first deploy.
                    </p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in generatedF" :key="entry.key" :entry="entry" />
                    </div>
                </RowGroup>

                <RowGroup v-if="groupVisible(capabilitiesF)" label="Capability credentials" :count="countSummary(capabilitiesF)">
                    <template #actions>
                        <Button label="Manage capabilities" size="small" severity="secondary" @click="router.push('/capabilities')" />
                    </template>
                    <p v-if="capabilitiesF.length === 0" class="px-4 py-2.5 text-xs text-subtle">No credentialed capabilities connected.</p>
                    <div v-else class="divide-y divide-line">
                        <SecretEntryRow v-for="entry in capabilitiesF" :key="entry.key" :entry="entry" editable />
                    </div>
                </RowGroup>

                <RowGroup v-if="groupVisible(providersF)" label="AI providers" :count="countSummary(providersF)">
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
                </RowGroup>
            </div>
        </template>
    </div>
</template>
