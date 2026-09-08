<script setup lang="ts">
import { Button, ui, FilterBar, type NoticeModel, NoticeStack, Row, RowGroup, RowNote, SegmentedControl, SkeletonRows } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import SecretEntryRow from "../../capabilities/connect/SecretEntryRow.vue";
import SecretField from "../../capabilities/connect/SecretField.vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { useExtensions } from "../../extensions/useExtensions";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxRequest } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSecretInventory } from "../../capabilities/connect/useSecrets";
import { matchesSecret, type SecretGroup, type SecretRow, secretRows } from "./secretRows";

// The one place every credential in this sandbox is visible, built to be scanned past a dozen rows. Owner-set
// values are the only "work" here (settable, removable); capability credentials are read-only and collapse behind a
// toggle past a threshold. Unfinished rows rise into one "Needs attention" group instead of a banner; the filter
// appears only once there's enough to search; nothing here reveals a value except the owner's own action.

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Below this many rows the list is its own overview; a display choice, kept out of the row model.
const FILTERABLE_FROM = 8;
// Same truncation as AiAccountSection, applied to capability credentials alone.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;

const { inventory, inventoryPending, refreshInventory } = useSecretInventory();
const outline = useSandboxOutline(inventoryPending);
const { capabilities } = useCapabilities();
const { enabled: enabledExtensions } = useExtensions();

// Gated on DevOps being `active` (not merely present): scaffolding-in-progress still 412s on /secrets writes.
const devopsActive = computed(() => capabilities.value.some((entry) => entry.kind === `devops` && entry.status.state === `active`));

// Provider accounts are excluded here (they live on the Agent tab) so nothing downstream must filter them.
const rows = computed<SecretRow[]>(() =>
    secretRows(inventory.value, { capabilities: capabilities.value, extensions: enabledExtensions.value }).filter((row) => row.group !== `provider`),
);

const query = ref(``);
const scope = ref<`all` | `missing`>(`all`);
// One row open at a time: the list must not grow unpredictably under the pointer while it is being scanned.
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

// Unfinished rows lifted out of their groups: the two reasons this tab gets opened in a hurry.
const attention = computed(() => matches.value.filter((row) => row.attention));
const held = (group: SecretGroup): SecretRow[] => matches.value.filter((row) => !row.attention && row.group === group);
const required = computed(() => held(`required`));
const yours = computed(() => held(`yours`));
const generated = computed(() => held(`generated`));
const credentials = computed(() => held(`credential`));

// Empty groups keep their informative note at rest, but drop out entirely while filtering.
const groupVisible = (list: readonly SecretRow[]): boolean => !filtering.value || list.length > 0;

// Same collapse pattern as AiAccountSection; filtering shows every match and hides the toggle.
const credentialsExpanded = ref(false);
const shouldCollapseCredentials = computed(() => credentials.value.length > COLLAPSE_THRESHOLD);
const collapsedCredentialCount = computed(() => credentials.value.length - VISIBLE_WHEN_COLLAPSED);
const visibleCredentials = computed(() => {
    if (filtering.value || !shouldCollapseCredentials.value || credentialsExpanded.value) {
        return credentials.value;
    }
    return credentials.value.slice(0, VISIBLE_WHEN_COLLAPSED);
});

const clearFilters = (): void => {
    query.value = ``;
    scope.value = `all`;
};

// Distinguishes still-loading, empty inventory, and no filter matches.
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

// CI sync: a stale entry gets the "Push to CI" action, which streams `intentic deploy secrets push`.
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

        <!--
            Two gates: content waits on `inventoryPending` (a half-read inventory never shows as empty), the outline waits
            on the reveal (a warm daemon skips the skeleton). Collapsing them into one flag loses one half.
        -->
        <template v-if="inventoryPending">
            <!--
                Shows the shape of the coming list (rows with a key and reveal control), not a spinner. Label sits inside the
                reveal so an empty bordered surface with a heading doesn't flash first.
            -->
            <RowGroup v-if="outline" label="Your secrets">
                <div role="status" aria-busy="true">
                    <span class="sr-only">Reading your sandbox's secrets…</span>
                    <SkeletonRows :rows="4" control />
                </div>
            </RowGroup>
        </template>

        <template v-else>
            <!-- Filter and scope narrow everything below as one control; the CI push button is separate and chromeless. -->
            <div v-if="filterable || ciKnown" class="flex flex-wrap items-center justify-end gap-2">
                <FilterBar
                    v-if="filterable"
                    v-model="query"
                    placeholder="Key, account or what uses it…"
                    :count="matches.length"
                    class="min-w-0 flex-1"
                >
                    <template #controls><SegmentedControl v-model="scope" :options="scopeOptions" /></template>
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

            <!-- Shown only while something is owed: the rows themselves, not a count of them. -->
            <RowGroup v-if="attention.length > 0" label="Needs attention" :count="attention.length">
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
                    <RowNote v-if="required.length === 0">Your intent declares no user-supplied secrets yet.</RowNote>
                    <SecretEntryRow
                        v-for="row in required"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>

                <!-- Gate sits on the group it gates, not atop the page: everything else here works with DevOps off. -->
                <!-- A navigating row is `<Row>` wrapped in `<RouterLink>` (the pattern it documents), at the list's own tier. -->
                <RowGroup v-else-if="!devopsActive && !filtering" label="Your secrets">
                    <RouterLink to="/capabilities" class="block no-underline">
                        <Row
                            interactive
                            chevron
                            icon="exclamation-triangle"
                            tone="warning"
                            title="Keeping your own secrets here needs DevOps active."
                        >
                            <template #meta><span class="font-medium text-link">Activate</span></template>
                        </Row>
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
                    <!-- `<RowNote action>`, not another hand-written spelling of this row, aligned with the chevron column above. -->
                    <RowNote v-if="!filtering && !adding" variant="action" label="Add a secret" @click="adding = true" />
                    <RowNote v-else-if="!filtering" variant="block">
                        <div class="flex flex-col gap-2">
                            <div class="flex items-start gap-2">
                                <input
                                    v-model="newKey"
                                    placeholder="KEY_NAME"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    :class="ui.input('w-44 shrink-0 font-mono')"
                                />
                                <SecretField class="flex-1" :secret-key="newKey" :disabled="!newKeyValid" no-hint @saved="newKey = ``" />
                            </div>
                            <span v-if="newKey.length > 0 && !newKeyValid" class="text-2xs text-warning">
                                Letters, digits and underscores; must not start with a digit.
                            </span>
                            <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" @click="cancelAdd">Cancel</button>
                        </div>
                    </RowNote>
                </RowGroup>

                <RowGroup v-if="devopsActive && groupVisible(generated)" label="Generated by intentic" :count="generated.length">
                    <RowNote v-if="generated.length === 0">Nothing generated yet: these appear after your first deploy.</RowNote>
                    <SecretEntryRow
                        v-for="row in generated"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>

                <!-- Same collapse-behind-toggle pattern as the Agent tab, once there are enough rows to crowd the rest of it. -->
                <RowGroup v-if="groupVisible(visibleCredentials)" label="Capability credentials" :count="credentials.length">
                    <template #actions>
                        <Button :as="RouterLink" to="/capabilities" label="Manage capabilities" size="small" severity="secondary" />
                    </template>
                    <SecretEntryRow
                        v-for="row in visibleCredentials"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                    <Row v-if="shouldCollapseCredentials && !filtering" interactive @click="credentialsExpanded = !credentialsExpanded">
                        <template #title>
                            <span class="flex items-center gap-2 text-2xs font-medium text-link">
                                <span class="flex w-[1.125rem] shrink-0 justify-center">
                                    <Icon :name="credentialsExpanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                                </span>
                                {{ credentialsExpanded ? `Show less` : `Show ${collapsedCredentialCount} more accounts` }}
                            </span>
                        </template>
                    </Row>
                </RowGroup>
            </div>

            <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
                <span>{{ emptyNote }}</span>
                <Button v-if="rows.length > 0" size="small" label="Clear filter" @click="clearFilters" />
            </div>
        </template>
    </div>
</template>
