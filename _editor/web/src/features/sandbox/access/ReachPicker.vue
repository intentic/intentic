<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { type CredentialReach, REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract/schemas/members";
import { BrandMark, SegmentedControl, SkeletonRows, ui } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { capabilitiesKey, fetchCapabilities } from "../../../models/capabilities/useCapabilities";
import { capabilityTile } from "../../../models/capabilities/tiles";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { type ReachDraft, toggledReach } from "./accessGrant";
import { useT } from "@intentic/ui/i18n";

// WHAT ONE PERSON'S ASSISTANTS MAY SPEND: every connected account and stored secret, or the ones ticked here. Enforced
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
const toggle = (kind: `capabilities` | `secrets`, subject: string, on: boolean): void => emit(`change`, toggledReach(picked.value, kind, subject, on));
const everyOne = (): void =>
    emit(`change`, { capabilities: accounts.value.map((account) => account.id), secrets: [...secrets.value] });
const noneOf = (): void => emit(`change`, { capabilities: [], secrets: [] });
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
            <template v-else>
                <div class="flex items-center gap-3">
                    <span class="text-xs text-muted">{{
                        t(`sandbox.sandboxAccess.reachPickedCount`, { picked: picked.capabilities.length + picked.secrets.length, total: accounts.length + secrets.length })
                    }}</span>
                    <span class="ml-auto flex items-center gap-3">
                        <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="disabled" @click="everyOne">
                            {{ t(`sandbox.sandboxAccess.selectAll`) }}
                        </button>
                        <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="disabled" @click="noneOf">
                            {{ t(`ui.action.clear`) }}
                        </button>
                    </span>
                </div>

                <div v-if="accounts.length > 0" class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.reachAccounts`) }}</span>
                    <div class="-mx-2.5 flex flex-col gap-0.5">
                        <label
                            v-for="account in accounts"
                            :key="account.id"
                            class="ui-row-select flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5"
                            :class="{ 'ui-row-select-on': picked.capabilities.includes(account.id), 'pointer-events-none opacity-60': disabled }"
                        >
                            <Checkbox
                                :model-value="picked.capabilities.includes(account.id)"
                                binary
                                size="small"
                                :disabled="disabled"
                                @update:model-value="(on: unknown) => toggle(`capabilities`, account.id, on === true)"
                            />
                            <BrandMark :size="22" :name="account.service ?? account.id" :logo="account.logo" :icon="account.icon" />
                            <span class="min-w-0 flex-1 truncate text-sm text-content">{{ account.id }}</span>
                            <span v-if="account.service" class="shrink-0 text-xs text-subtle">{{ account.service }}</span>
                        </label>
                    </div>
                </div>

                <div v-if="secrets.length > 0" class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel({ size: `xs` })">{{ t(`sandbox.sandboxAccess.reachSecrets`) }}</span>
                    <div class="-mx-2.5 flex flex-col gap-0.5">
                        <label
                            v-for="name in secrets"
                            :key="name"
                            class="ui-row-select flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5"
                            :class="{ 'ui-row-select-on': picked.secrets.includes(name), 'pointer-events-none opacity-60': disabled }"
                        >
                            <Checkbox
                                :model-value="picked.secrets.includes(name)"
                                binary
                                size="small"
                                :disabled="disabled"
                                @update:model-value="(on: unknown) => toggle(`secrets`, name, on === true)"
                            />
                            <span class="flex size-5.5 shrink-0 items-center justify-center text-subtle"><Icon name="key" class="text-xs" /></span>
                            <span class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ name }}</span>
                        </label>
                    </div>
                </div>
            </template>
        </template>

        <p v-if="alwaysShared.length > 0" class="text-xs text-subtle">
            {{ t(`sandbox.sandboxAccess.reachAlwaysShared`, { names: alwaysShared.join(`, `) }) }}
        </p>
    </div>
</template>
