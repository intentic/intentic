<script setup lang="ts">
import { cmp, FilterBar, type NoticeModel, NoticeStack, RowGroup, Segmented } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import SecretEntryRow from "../../components/SecretEntryRow.vue";
import SecretField from "../../components/SecretField.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { readIntenticLines } from "../../composables/intenticStream";
import { sandboxRequest } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { useSecretInventory } from "../../composables/secrets/useSecrets";
import { matchesSecret, type SecretGroup, type SecretRow, secretRows } from "./secretRows";

/* THE ONE PLACE EVERY CREDENTIAL IN THIS SANDBOX IS VISIBLE — and, past a dozen of them, a list built to be
 * scanned rather than read. It is the Extensions tab's four rules over a different subject, because it is the
 * same problem: a tab whose length is the number of things you own.
 *
 * IT HOLDS TWO KINDS OF THING AND ONLY ONE OF THEM IS WORK (see ./secretRows). The owner's own values can be
 * missing, are set and rotated and removed here, and a deploy fails without them. Everything under "Connected
 * accounts" is a credential belonging to a connection or a subscription: connected by construction, unsettable
 * from here, and already managed one click away. That half is what grows without limit — one row per account —
 * so it is FOLDED once it is big enough to bury the half that is work. It is still here, still searchable,
 * still one click from its value; it just stops setting the length of the page.
 *
 * WHAT IS OWED IS PINNED, AND THE BANNER IS GONE. A strip at the top saying "3 required secrets are not set"
 * named a number and then left the reader to find three rows scattered down five groups. The rows themselves
 * rise into one group above everything instead — the extension tab's precedent, and the same argument: a
 * summary of a problem is worth less than the problem, in a place you can act on it.
 *
 * THE INSTRUMENT ARRIVES WHEN IT IS EARNED. Below a handful of secrets the list IS the overview and a filter
 * box is more chrome than the thing it filters; past that, finding beats scrolling, and the box matches what a
 * row SHOWS (the account, the brand, what uses it) rather than only the key the daemon stored it under.
 *
 * Values stay in the sandbox — the only value-returning action anywhere here is the owner-only reveal. */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Below this many rows the list is its own overview; below this many accounts the fold saves nothing. Both are
// display choices, so they live here rather than in the row model.
const FILTERABLE_FROM = 8;
const FOLD_FROM = 8;

const { inventory, inventoryPending, refreshInventory } = useSecretInventory();
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();
const router = useRouter();

// DevOps scaffolds the desired-state repo the env/generated secrets live in; until its capability reports
// `active`, those groups are empty and every /secrets write 412s — so gate them on this signal (state, not
// mere presence: a scaffolding devops sits at `pending`).
const devopsActive = computed(() => capabilities.value.some((entry) => entry.kind === `devops` && entry.status.state === `active`));

// Every secret as this tab reads it: named, marked, and sorted with whatever is unfinished first.
const rows = computed<SecretRow[]>(() => secretRows(inventory.value, { capabilities: capabilities.value, extensions: enabledExtensions.value }));

const query = ref(``);
const scope = ref<`all` | `missing`>(`all`);
// One row open at a time — the list must not grow unpredictably under the pointer while it is being scanned.
const opened = ref<string | undefined>(undefined);

const filterable = computed(() => rows.value.length >= FILTERABLE_FROM);
const missingCount = computed(() => rows.value.filter((row) => row.entry.status === `missing`).length);
const scopeOptions = computed(() => [
    { label: `All`, value: `all` as const, badge: rows.value.length },
    { label: `Missing`, value: `missing` as const, badge: missingCount.value },
]);
const filtering = computed(() => query.value.trim() !== `` || scope.value !== `all`);
const matches = computed<SecretRow[]>(() => {
    const needle = query.value.trim().toLowerCase();
    return rows.value.filter((row) => matchesSecret(row, needle, scope.value === `missing`));
});

/* WHAT IS OUTSTANDING, lifted out of the groups it belongs to. A missing required value and a copy CI never got
 * are the two things this tab is opened in a hurry for, and either can sit under any heading. */
const attention = computed(() => matches.value.filter((row) => row.attention));
const held = (group: SecretGroup): SecretRow[] => matches.value.filter((row) => !row.attention && row.group === group);
const required = computed(() => held(`required`));
const yours = computed(() => held(`yours`));
const generated = computed(() => held(`generated`));
const credentials = computed(() => held(`credential`));
const providers = computed(() => held(`provider`));

// Empty groups keep their informative note at rest, but drop out entirely while filtering.
const groupVisible = (list: readonly SecretRow[]): boolean => !filtering.value || list.length > 0;
/* The accounts fold: open while small, open while anything is being looked for, shut when it would otherwise
 * bury the half of this tab that is actually work.
 *
 * A READER WHO OPENS IT KEEPS IT OPEN. Searching forces it open — the matches are inside, and a filter that
 * silently omitted them would make this tab lie about what the sandbox holds — and clearing that search used to
 * fold it back over the reader who had opened it by hand a minute earlier. Their own answer is remembered
 * instead, and only recorded when it IS their answer: a fold opened by a search is not a preference. */
const accountCount = computed(() => credentials.value.length + providers.value.length);
const openedByHand = ref<boolean | undefined>(undefined);
const accountsOpen = computed(() => filtering.value || (openedByHand.value ?? accountCount.value <= FOLD_FROM));
const rememberFold = (event: Event): void => {
    if (!filtering.value) {
        openedByHand.value = (event.target as HTMLDetailsElement).open;
    }
};

const clearFilters = (): void => {
    query.value = ``;
    scope.value = `all`;
};

// Three different facts, and the wrong one is a lie the reader can see.
const emptyNote = computed<string | undefined>(() => {
    if (inventoryPending.value || matches.value.length > 0) {
        return undefined;
    }
    return rows.value.length === 0 ? `Nothing in this sandbox holds a credential yet.` : `Nothing matches that filter.`;
});

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
    <div class="flex flex-col gap-5">
        <NoticeStack :of="[pushError]" />

        <div v-if="inventoryPending" :class="cmp.emptyState('py-6')"><Icon name="spinner" spin /> Reading your sandbox's secrets…</div>

        <template v-else>
            <!-- The tab's instrument, not any one group's: the filter and the scope narrow everything below and
                 read as one control, while pushing the set to CI does not and stays chromeless beside them. -->
            <div v-if="filterable || ciKnown" class="flex flex-wrap items-center justify-end gap-2">
                <FilterBar
                    v-if="filterable"
                    v-model="query"
                    placeholder="Key, account or what uses it…"
                    :count="matches.length"
                    class="min-w-0 flex-1"
                >
                    <template #controls><Segmented v-model="scope" :options="scopeOptions" /></template>
                </FilterBar>
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

            <!-- WHAT IS OWED, above everything and only while something is. This is the strip that used to say
                 "3 required secrets are not set", except it is the three secrets. -->
            <RowGroup
                v-if="attention.length > 0"
                label="Needs attention"
                caption="required values nobody has set, and copies CI never got"
                :count="attention.length"
            >
                <SecretEntryRow
                    v-for="row in attention"
                    :key="row.entry.key"
                    :row="row"
                    :expanded="opened === row.entry.key"
                    @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                />
            </RowGroup>

            <!-- The owner's own: what they must keep, what they chose to keep, what intentic keeps for them. -->
            <div class="flex flex-col gap-6">
                <RowGroup v-if="devopsActive && groupVisible(required)" label="Required by your intent" :count="required.length">
                    <p v-if="required.length === 0" class="px-4 py-2.5 text-xs text-subtle">Your intent declares no user-supplied secrets yet.</p>
                    <SecretEntryRow
                        v-for="row in required"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>

                <!-- The gate sits on the group it gates rather than at the top of the page: with DevOps off,
                     everything else on this tab works, and a banner over the whole thing said otherwise. -->
                <RowGroup v-else-if="!devopsActive && !filtering" label="Your secrets">
                    <RouterLink
                        to="/capabilities"
                        class="flex items-center gap-2 px-4 py-3 text-xs text-content no-underline transition-colors hover:bg-canvas"
                    >
                        <Icon name="exclamation-triangle" class="shrink-0 text-warning" />
                        <span>Keeping your own secrets here needs DevOps active.</span>
                        <span class="ml-auto inline-flex items-center gap-1 font-medium text-link"
                            >Activate <Icon name="arrow-right" class="text-2xs"
                        /></span>
                    </RouterLink>
                </RowGroup>

                <RowGroup v-if="devopsActive && groupVisible(yours)" label="Your secrets" :count="yours.length">
                    <SecretEntryRow
                        v-for="row in yours"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
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

                <RowGroup v-if="devopsActive && groupVisible(generated)" label="Generated by intentic" :count="generated.length">
                    <p v-if="generated.length === 0" class="px-4 py-2.5 text-xs text-subtle">
                        Nothing generated yet — these appear after your first deploy.
                    </p>
                    <SecretEntryRow
                        v-for="row in generated"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>
            </div>

            <!-- AND THE HALF THAT IS NOT WORK: one line at rest once there are enough of them to bury the rest
                 of the tab, exactly as a mass change folds in the deploy preview. Open, it is the inventory the
                 Capabilities page shows — same names, same marks, same one click back to where they are set up. -->
            <details v-if="accountCount > 0" class="group/fold" :open="accountsOpen" @toggle="rememberFold">
                <summary class="flex cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden">
                    <Icon name="chevron-right" aria-hidden="true" class="text-xs text-subtle transition-transform group-open/fold:rotate-90" />
                    <span :class="cmp.sectionLabel()">Connected accounts</span>
                    <span class="text-2xs font-medium text-subtle">{{ accountCount }}</span>
                    <span class="min-w-0 text-2xs text-subtle">held by your connections — set up where they were added</span>
                </summary>

                <div class="mt-3 flex flex-col gap-6">
                    <RowGroup v-if="credentials.length > 0" label="Capability credentials" :count="credentials.length">
                        <template #actions>
                            <Button label="Manage capabilities" size="small" severity="secondary" @click="router.push('/capabilities')" />
                        </template>
                        <SecretEntryRow
                            v-for="row in credentials"
                            :key="row.entry.key"
                            :row="row"
                            :expanded="opened === row.entry.key"
                            @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                        />
                    </RowGroup>

                    <RowGroup v-if="providers.length > 0" label="AI providers" :count="providers.length">
                        <template #actions>
                            <Button label="Manage accounts" size="small" severity="secondary" @click="router.push('/sandbox/agent')" />
                        </template>
                        <SecretEntryRow
                            v-for="row in providers"
                            :key="row.entry.key"
                            :row="row"
                            :expanded="opened === row.entry.key"
                            @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                        />
                    </RowGroup>
                </div>
            </details>

            <div v-if="emptyNote !== undefined" :class="cmp.emptyState(`flex flex-col items-center gap-2 py-6`)">
                <span>{{ emptyNote }}</span>
                <Button v-if="rows.length > 0" size="small" label="Clear filter" @click="clearFilters" />
            </div>
        </template>
    </div>
</template>
