<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { type CredentialReach, REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract/schemas/members";
import { BrandMark, SegmentedControl, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { capabilitiesKey, fetchCapabilities } from "../../../models/capabilities/useCapabilities";
import { capabilityTile } from "../../../models/capabilities/tiles";
import { useExtensions } from "../../../models/extensions/useExtensions";
import type { ReachDraft } from "./accessGrant";
import MultiPick from "./pick/MultiPick.vue";
import type { PickEntry, PickOption, PickSection } from "./pick/multiPick";
import { useT } from "@intentic/ui/i18n";

// WHAT ONE PERSON'S ASSISTANTS MAY SPEND: every connected account and stored secret, or the ones picked here. Enforced
// by the sandbox, not told to the model: what is left out is never loaded into their conversations and every exit
// that would spend it refuses (the daemon's secrets/credential-reach.ts). Only the kinds a reach can actually hold
// back are listed; the rest (Docker, a VPN, a local model) have no credential to withhold, so they are named once
// below as always available rather than drawn as switches that would do nothing.

const t = useT();

const { reach, disabled = false } = defineProps<{ reach: ReachDraft; disabled?: boolean }>();
const emit = defineEmits<{ change: [reach: ReachDraft] }>();

// Reads only, on the same cache entries the Capabilities and Secrets pages fill: this picker writes neither.
const { query: capabilitiesQuery } = useSandboxQuery({ queryKey: capabilitiesKey, queryFn: fetchCapabilities });
const { query: inventoryQuery } = useSandboxQuery(rpcQuery(`secrets.inventory`));
const { enabled: extensions } = useExtensions();
const capabilities = computed<CapabilitySummary[]>(() => capabilitiesQuery.data.value?.capabilities ?? []);
const inventory = computed(() => inventoryQuery.data.value?.entries ?? []);

const withholdable = (capability: CapabilitySummary): boolean => REACHABLE_CREDENTIAL_KINDS.includes(capability.kind);

// One row per connection: its own name, and the service it is when the name does not already say so.
const accounts = computed(() =>
    capabilities.value.filter(withholdable).map((capability) => {
        // A connection whose tile is not installed here is named by itself alone, never by its kind's internal word.
        const tile = capabilityTile(capability, extensions.value);
        return {
            id: capability.id,
            family: tile?.name,
            service: tile === undefined || tile.name.toLowerCase() === capability.id.toLowerCase() ? undefined : tile.name,
            logo: tile?.logo,
            icon: tile?.icon,
        };
    }),
);
// The kinds nothing withholds, by the name a person knows them by.
const alwaysShared = computed(() =>
    capabilities.value.filter((capability) => !withholdable(capability)).map((capability) => capabilityTile(capability, extensions.value)?.name ?? capability.id),
);
// Values a person or the sandbox keeps, by the name a reference spends them under. A connection's own credential is its
// row above, and a model account's is the runtime's, never an agent's to spend.
const secrets = computed(() => inventory.value.filter((entry) => entry.kind === `env` || entry.kind === `generated`).map((entry) => entry.key));

const reading = computed(() => capabilitiesQuery.isPending.value || inventoryQuery.isPending.value);

type Mode = `all` | `some`;
const mode = computed<Mode>(() => (reach === `all` ? `all` : `some`));
const MODES = computed(() => [
    { value: `all` as const, label: t(`sandbox.sandboxAccess.reachAll`), icon: `check-circle` as const },
    { value: `some` as const, label: t(`sandbox.sandboxAccess.reachSome`), icon: `lock` as const },
]);
// Narrowing starts from nothing ticked: a reach that silently held everything would read as limited while reaching
// all of it, and the owner names what they mean to hand over row by row.
const pickMode = (next: Mode): void => emit(`change`, next === `all` ? `all` : { capabilities: [], secrets: [] });

const picked = computed<CredentialReach>(() => (reach === `all` ? { capabilities: [], secrets: [] } : reach));

// One list for the picker, so a connection and a secret of the same name stay two things: each value says its kind.
const CONNECTION = `c:`;
const SECRET = `s:`;
const pickedValues = computed(() => [
    ...picked.value.capabilities.map((id) => `${CONNECTION}${id}`),
    ...picked.value.secrets.map((name) => `${SECRET}${name}`),
]);
const fromValues = (values: readonly string[]): CredentialReach => ({
    capabilities: values.filter((value) => value.startsWith(CONNECTION)).map((value) => value.slice(CONNECTION.length)),
    secrets: values.filter((value) => value.startsWith(SECRET)).map((value) => value.slice(SECRET.length)),
});
const change = (values: readonly string[]): void => emit(`change`, fromValues(values));

// Accounts of one service sit together as a family the owner can hand over whole (every Reddit account, every
// identity), in the place the first of them was connected; a service with one account is a row like any other.
const sections = computed<PickSection[]>(() => {
    const families = new Map<string, PickOption[]>();
    for (const account of accounts.value) {
        if (account.family !== undefined) {
            families.set(account.family, [...(families.get(account.family) ?? []), { value: `${CONNECTION}${account.id}`, label: account.id, note: account.service }]);
        }
    }
    const placed = new Set<string>();
    const entries = accounts.value.flatMap((account): PickEntry[] => {
        const members = account.family === undefined ? undefined : families.get(account.family);
        if (account.family === undefined || members === undefined || members.length < 2) {
            return [{ value: `${CONNECTION}${account.id}`, label: account.id, note: account.service }];
        }
        if (placed.has(account.family)) {
            return [];
        }
        placed.add(account.family);
        return [{ family: account.family, label: account.family, lead: `${CONNECTION}${account.id}`, options: members }];
    });
    return [
        ...(entries.length > 0 ? [{ key: `connections`, label: t(`sandbox.sandboxAccess.reachAccounts`), icon: `link` as const, entries }] : []),
        ...(secrets.value.length > 0
            ? [
                  {
                      key: `secrets`,
                      label: t(`sandbox.sandboxAccess.reachSecrets`),
                      icon: `key` as const,
                      entries: secrets.value.map((name) => ({ value: `${SECRET}${name}`, label: name, mono: true })),
                  },
              ]
            : []),
    ];
});
const byValue = computed(() => new Map(accounts.value.map((account) => [`${CONNECTION}${account.id}`, account])));
</script>

<template>
    <div class="flex flex-col gap-3">
        <SegmentedControl :model-value="mode" :options="MODES" :class="{ 'pointer-events-none opacity-60': disabled }" @update:model-value="pickMode" />
        <p class="text-xs text-muted">
            {{ mode === `all` ? t(`sandbox.sandboxAccess.reachAllNote`) : t(`sandbox.sandboxAccess.reachSomeNote`) }}
        </p>

        <template v-if="mode === `some`">
            <div v-if="reading" role="status" aria-busy="true"><SkeletonRows :rows="3" /></div>
            <p v-else-if="accounts.length === 0 && secrets.length === 0" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.reachNothingConnected`) }}</p>
            <MultiPick
                v-else
                :sections="sections"
                :picked="pickedValues"
                :search-label="t(`sandbox.sandboxAccess.reachSearch`)"
                :aria-label="t(`sandbox.sandboxAccess.reachSection`)"
                tally
                :disabled="disabled"
                @change="change"
            >
                <template #mark="{ value, size }">
                    <BrandMark
                        v-if="byValue.has(value)"
                        :size="size"
                        :name="byValue.get(value)?.family ?? byValue.get(value)?.id ?? value"
                        :logo="byValue.get(value)?.logo"
                        :icon="byValue.get(value)?.icon"
                    />
                    <span v-else class="flex shrink-0 items-center justify-center text-subtle" :style="{ width: `${size}px`, height: `${size}px` }">
                        <Icon name="key" class="text-2xs" />
                    </span>
                </template>
            </MultiPick>
        </template>

        <p v-if="alwaysShared.length > 0" class="text-xs text-subtle">
            {{ t(`sandbox.sandboxAccess.reachAlwaysShared`, { names: alwaysShared.join(`, `) }) }}
        </p>
    </div>
</template>
