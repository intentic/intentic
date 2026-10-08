<script setup lang="ts">
import {
    Button,
    ui,
    FilterBar,
    type NoticeModel,
    NoticeStack,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    SkeletonSnapshot,
    vSkeletonSource,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { SECRET_KEY_MAX, SECRET_KEY_RE } from "@intentic/sandbox-contract";
import { computed, nextTick, ref, useTemplateRef } from "vue";
import { RouterLink, useRoute } from "vue-router";
import SecretEntryRow from "../../capabilities/connect/secrets/SecretEntryRow.vue";
import SecretField from "../../capabilities/connect/secrets/SecretField.vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { useExtensions } from "../../extensions/useExtensions";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSecretInventory } from "../../capabilities/connect/secrets/useSecrets";
import { matchesSecret, type SecretGroup, type SecretRow, secretRows } from "./secretRows";
import { useT } from "@intentic/ui/i18n";

// The one place every credential in this sandbox is visible, built to be scanned past a dozen rows. Owner-set
// values are the only "work" here (settable, removable); capability credentials are read-only and collapse behind a
// toggle past a threshold. Unfinished rows rise into one "Needs attention" group instead of a banner; the filter
// appears only once there's enough to search; nothing here reveals a value except the owner's own action.

// The daemon's own rule, imported rather than restated, so the box cannot accept a name the write will refuse.
// Below this many rows the list is its own overview; a display choice, kept out of the row model.
const t = useT();

const FILTERABLE_FROM = 8;
// A long credential list folds to its first few rows behind a toggle; applied to capability credentials alone.
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
    { label: t(`sandbox.words.all`), value: `all` as const, badge: rows.value.length },
    { label: t(`sandbox.sandboxSecrets.missing`), value: `missing` as const, badge: missingCount.value },
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

// Collapsed past the threshold above; filtering shows every match and hides the toggle.
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
    return rows.value.length === 0 ? t(`sandbox.sandboxSecrets.noCredentialsYet`) : t(`sandbox.sandboxSecrets.nothingMatchesFilter`);
});

// Add-a-secret (any env key the user wants available at apply time); collapsed until invoked, or opened on arrival by
// a link naming the key (`/sandbox/secrets?add=NAME`), which is how an agent's message points at the one to add.
const route = useRoute();
const linked = typeof route.query[`add`] === `string` ? route.query[`add`] : ``;
const adding = ref(SECRET_KEY_RE.test(linked));
const newKey = ref(SECRET_KEY_RE.test(linked) ? linked : ``);
const newKeyValid = computed(() => SECRET_KEY_RE.test(newKey.value) && newKey.value.length <= SECRET_KEY_MAX);
// A name already here would be overwritten by Save with no warning; said before the box can be used, not after.
const newKeyTaken = computed(() => newKeyValid.value && inventory.value.some((entry) => entry.key === newKey.value));
const newKeyProblem = computed<string | undefined>(() => {
    if (newKey.value.length === 0) {
        return undefined;
    }
    if (newKey.value.length > SECRET_KEY_MAX) {
        return t(`sandbox.sandboxSecrets.nameTooLong`, { max: SECRET_KEY_MAX, length: newKey.value.length });
    }
    if (!newKeyValid.value) {
        return t(`sandbox.sandboxSecrets.nameCharacters`);
    }
    return newKeyTaken.value ? t(`sandbox.sandboxSecrets.nameTaken`, { name: newKey.value }) : undefined;
});
// The add row opens from the page's own action bar: it clears any filter first, since a filter folds the row away.
const newKeyInput = useTemplateRef<HTMLInputElement>(`newKeyInput`);
const openAdd = async (): Promise<void> => {
    clearFilters();
    adding.value = true;
    await nextTick();
    newKeyInput.value?.focus();
};
const cancelAdd = (): void => {
    adding.value = false;
    newKey.value = ``;
};

// A value nobody has to find (a session key, a signing secret): the daemon makes and keeps it, and this page never
// holds it. Offered only for a new name, since a new value would break whatever reads the old one.
const generating = ref(false);
const generateError = ref<NoticeModel | undefined>(undefined);
const generateOne = async (): Promise<void> => {
    if (!newKeyValid.value || newKeyTaken.value) {
        return;
    }
    generating.value = true;
    generateError.value = undefined;
    try {
        await sandboxRpc.secrets.generate({ key: newKey.value });
        newKey.value = ``;
        refreshInventory();
    } catch (err) {
        generateError.value = noticeFrom(err, t(`sandbox.sandboxSecrets.couldNotGenerate`));
    } finally {
        generating.value = false;
    }
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
        const lines = await sandboxRpc.intentic.run({ args: [`deploy`, `secrets`, `push`] });
        for await (const line of readIntenticLines(lines)) {
            if (line[`kind`] === `error` && typeof line[`message`] === `string`) {
                throw new Error(line[`message`]);
            }
        }
        refreshInventory();
    } catch (err) {
        pushError.value = noticeFrom(err, t(`sandbox.sandboxSecrets.couldntPushToCi`));
    } finally {
        pushing.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <NoticeStack :of="[pushError]" />

        <!-- Content waits for inventory; the outline waits for the reveal, drawn as the page last looked in this sandbox. -->
        <template v-if="inventoryPending">
            <SkeletonSnapshot v-if="outline" of="sandbox.secrets" :label="t(`sandbox.sandboxSecrets.readingSandboxsSecrets`)">
                <!-- Until it has been seen once: the shape of the coming list (rows with a key and reveal control), not a spinner. -->
                <RowGroup :label="t(`sandbox.sandboxSecrets.secrets`)">
                    <div role="status" aria-busy="true">
                        <span class="sr-only">{{ t(`sandbox.sandboxSecrets.readingSandboxsSecrets`) }}</span>
                        <SkeletonRows :rows="4" control />
                    </div>
                </RowGroup>
            </SkeletonSnapshot>
        </template>

        <!-- One element, so its imprint is the whole page below the notices; spaced as the column it sits in. -->
        <div v-else v-skeleton-source="`sandbox.secrets`" class="flex flex-col gap-6">
            <!-- Filter and scope narrow everything below as one control; the page's actions sit beside it, so adding a secret
                 needs no section of its own while there is nothing in it yet. -->
            <div class="flex flex-wrap items-center justify-end gap-2">
                <FilterBar
                    v-if="filterable"
                    v-model="query"
                    :placeholder="t(`sandbox.sandboxSecrets.keyAccountWhatUses`)"
                    :count="matches.length"
                    class="min-w-0 flex-1"
                >
                    <template #controls><SegmentedControl v-model="scope" :options="scopeOptions" /></template>
                </FilterBar>
                <Button :label="t(`sandbox.sandboxSecrets.addSecret`)" size="small" :disabled="adding" @click="openAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
                <Button :as="RouterLink" to="/capabilities" :label="t(`sandbox.sandboxSecrets.manageCapabilities`)" size="small" tier="boring" />
                <Button
                    v-if="ciKnown"
                    :label="ciStale ? t(`sandbox.sandboxSecrets.pushToCi`) : t(`sandbox.sandboxSecrets.ciInSync`)"
                    size="small"
                    :tier="ciStale ? `accent` : `boring`"
                    :disabled="!ciStale"
                    :loading="pushing"
                    @click="pushToCi"
                >
                    <template #icon><Icon :name="ciStale ? `cloud-upload` : `check`" /></template>
                </Button>
            </div>

            <!-- Shown only while something is owed: the rows themselves, not a count of them. -->
            <RowGroup v-if="attention.length > 0" :label="t(`sandbox.words.needsAttention`)" :count="attention.length">
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
                <RowGroup
                    v-if="devopsActive && groupVisible(required)"
                    :label="t(`sandbox.sandboxSecrets.requiredByIntent`)"
                    :count="required.length"
                >
                    <RowNote v-if="required.length === 0">{{ t(`sandbox.sandboxSecrets.intentDeclaresNoUser`) }}</RowNote>
                    <SecretEntryRow
                        v-for="row in required"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>

                <!-- A person's own secrets need no DevOps: without it they go to the sandbox's own store, the one a need's card writes to too. -->
                <!-- Drawn only once it holds something, or while a new one is being named: an empty group is just a header. -->
                <RowGroup v-if="(yours.length > 0 || adding) && groupVisible(yours)" :label="t(`sandbox.sandboxSecrets.secrets`)">
                    <SecretEntryRow
                        v-for="row in yours"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                    <RowNote v-if="!filtering && adding" variant="block">
                        <div class="flex flex-col gap-2">
                            <div class="flex items-start gap-2">
                                <input
                                    ref="newKeyInput"
                                    v-model="newKey"
                                    :placeholder="t(`sandbox.sandboxSecrets.keyName`)"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    :class="ui.input('w-44 shrink-0 font-mono')"
                                />
                                <SecretField class="flex-1" :secret-key="newKey" :disabled="!newKeyValid" no-hint @saved="newKey = ``" />
                            </div>
                            <span v-if="newKeyProblem" :class="newKeyTaken ? `text-2xs text-subtle` : `text-2xs text-warning`">
                                {{ newKeyProblem }}
                            </span>
                            <div class="flex items-center gap-3">
                                <button
                                    v-if="newKeyValid && !newKeyTaken"
                                    type="button"
                                    :class="ui.textButton({ size: `xs` })"
                                    :disabled="generating"
                                    v-tooltip.top="{
                                        title: t(`sandbox.sandboxSecrets.neverShown`),
                                        note: t(`sandbox.sandboxSecrets.sessionOrSigningKeys`),
                                    }"
                                    @click="generateOne"
                                >
                                    {{ t(`sandbox.sandboxSecrets.generateRandom`) }}
                                </button>
                                <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="cancelAdd">
                                    {{ t(`ui.action.cancel`) }}
                                </button>
                            </div>
                            <NoticeStack :of="[generateError]" />
                        </div>
                    </RowNote>
                </RowGroup>

                <RowGroup
                    v-if="devopsActive && groupVisible(generated)"
                    :label="t(`sandbox.sandboxSecrets.generatedByIntentic`)"
                    :count="generated.length"
                >
                    <RowNote v-if="generated.length === 0">{{ t(`sandbox.sandboxSecrets.nothingGeneratedYetAppear`) }}</RowNote>
                    <SecretEntryRow
                        v-for="row in generated"
                        :key="row.entry.key"
                        :row="row"
                        :expanded="opened === row.entry.key"
                        @update:expanded="(open) => (opened = open ? row.entry.key : undefined)"
                    />
                </RowGroup>

                <!-- Same collapse-behind-toggle pattern as the Agent tab, once there are enough rows to crowd the rest of it. -->
                <RowGroup v-if="groupVisible(visibleCredentials)" :label="t(`sandbox.sandboxSecrets.capabilityCredentials`)">
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
                                {{
                                    credentialsExpanded
                                        ? t(`ui.action.showLess`)
                                        : t(`sandbox.sandboxSecrets.showMoreAccounts`, { collapsedCredentialCount })
                                }}
                            </span>
                        </template>
                    </Row>
                </RowGroup>
            </div>

            <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
                <span>{{ emptyNote }}</span>
                <Button v-if="rows.length > 0" size="small" :label="t(`ui.action.clearFilter`)" @click="clearFilters" />
            </div>
        </div>
    </div>
</template>
