<!-- Sandbox ▸ Models' "From your other sandboxes": the owner's model accounts on another of their sandboxes, each brought in here the way that is safe for it, without signing in again. -->
<script setup lang="ts">
import { isEndpointProvider, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { type NativeProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { BorrowOutcome, ShareableAccount, ShareableAccounts } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { Button, Icon, Notice, type NoticeModel, Picker, type PickerOption, Row, RowGroup, RowNote, type RowTone } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef, watch } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { pairableSandboxes } from "../../../components/linkPairing";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { useOperation } from "../../../workbench/operations/operations";
import { isProviderTile } from "./providerGrid";
import { bringable, bringAccounts, broughtIn, mergeOutcomes, refKey, refOf } from "./shareAccounts";
import { accountsMoved, borrowHere, farShareCalls, shareableAt } from "./useAccountSharing";

const t = useT();

const { busy = false } = defineProps<{
    // A sign-in is on its way to the sandbox: no second one from here until it answers.
    busy?: boolean;
}>();
// Signing in here instead is the page's one sign-in (SandboxModels.vue `connect`), not a door of this section's own.
const emit = defineEmits<{ signIn: [provider: NativeProvider] }>();

const { sandboxes, active, activeSandboxId, daemonUrl } = useSandbox();
const { canShip } = useRole();
const { capabilities, add, refetch } = useCapabilities();

// The owner's other sandboxes this editor may make a link on, as pairing a task link picks them (linkPairing.ts).
const others = computed(() => pairableSandboxes(sandboxes.value, activeSandboxId.value));
const sourceOptions = computed<readonly PickerOption<string>[]>(() => others.value.map((sandbox) => ({ value: sandbox.id, label: sandbox.name })));
// Shown only where it can work: a reader who may connect things, another sandbox to bring from, a daemon with the route.
const shown = computed(() => canShip.value && others.value.length > 0 && supportsRoute(`sharing.borrow`));

const sourceId = ref<string>();
const source = computed(() => others.value.find((sandbox) => sandbox.id === sourceId.value));

// What the source holds, read once per pick as the reader there; and what each press this visit did, by account.
const listing = shallowRef<ShareableAccounts>();
const reading = ref(false);
const readNotice = shallowRef<NoticeModel>();
const outcomes = shallowRef<ReadonlyMap<string, BorrowOutcome>>(new Map());

watch(sourceId, async (id) => {
    listing.value = undefined;
    readNotice.value = undefined;
    outcomes.value = new Map();
    const picked = source.value;
    if (picked === undefined) {
        return;
    }
    reading.value = true;
    try {
        const answer = await shareableAt(picked.id);
        if (sourceId.value === id) {
            listing.value = answer;
        }
    } catch (failure) {
        if (sourceId.value === id) {
            // A sandbox from before accounts could be shared has no such route at all: said as what it is.
            readNotice.value =
                failure instanceof SandboxHttpError && failure.status === 404
                    ? { tone: `warning`, title: t(`connect.shareAccounts.tooOld`, { name: picked.name }) }
                    : noticeFrom(failure, t(`connect.shareAccounts.couldntRead`, { name: picked.name }));
        }
    } finally {
        if (sourceId.value === id) {
            reading.value = false;
        }
    }
});

// THE PRESS, kept in the operations ledger as copying a found key is: it makes a link over there and a card here, then
// brings the accounts in, whether or not this page stays open. One at a time, tagged with the row it brings (or all).
const ALL = `all`;
const bringOp = useOperation<readonly BorrowOutcome[]>(`models/share/bring`);
const bringing = computed(() => (bringOp.busy.value ? bringOp.operation.value?.tag : undefined));
const bringNotice = bringOp.failure;

const bring = async (accounts: readonly ShareableAccount[], tag: string): Promise<void> => {
    const from = source.value;
    if (from === undefined || bringing.value !== undefined || accounts.length === 0) {
        return;
    }
    const ended = await bringOp.run({
        what: t(`connect.shareAccounts.bringing`, { name: from.name }),
        tag,
        quiet: true,
        failed: t(`connect.shareAccounts.couldntBring`, { name: from.name }),
        task: async () => {
            // This sandbox's cards as they stand now, so a card saved since the page loaded is widened, not made twice.
            const cards = (await refetch()).data?.capabilities ?? capabilities.value;
            const results = await bringAccounts(
                {
                    source: { id: from.id, name: from.name, daemonUrl: from.daemonUrl },
                    here: { id: activeSandboxId.value, name: active.value?.name ?? t(`capabilities.linkPairing.thisSandbox`), url: daemonUrl.value },
                    refs: accounts.map(refOf),
                    cards,
                },
                { ...farShareCalls, saveCard: (card) => add(card), borrow: borrowHere },
            );
            // The picker and every panel read accounts off the connection list, which has never heard of these.
            await accountsMoved();
            return results;
        },
    });
    if (ended?.state !== `done`) {
        return;
    }
    outcomes.value = mergeOutcomes(outcomes.value, ended.value ?? []);
    bringOp.dismiss();
};

// A row per account the source holds: what it is, how it would come here, and what a press here did to it.
interface ShareRow {
    readonly key: string;
    readonly account: ShareableAccount;
    readonly title: string;
    readonly description: string;
    readonly tone: RowTone;
    // Copied or Borrowed, once a press this visit brought it in.
    readonly done: string | undefined;
    readonly canBring: boolean;
    // The provider whose own sign-in this page can start, for "Sign in here instead".
    readonly signIn: NativeProvider | undefined;
}

const providerName = (provider: string): string =>
    isEndpointProvider(provider) ? t(`connect.shareAccounts.endpoint`) : (providerSpec(provider)?.accountLabel ?? providerLabel(provider));

// How it would come here, first on its line since it is what the row is for: the mode's word, or why it cannot come.
const modeLine = (account: ShareableAccount): string =>
    account.mode === `copy`
        ? t(`connect.shareAccounts.modeCopy`)
        : account.mode === `lend`
          ? t(`connect.shareAccounts.modeLend`)
          : (account.reason ?? t(`connect.shareAccounts.modeNo`));

const rowOf = (account: ShareableAccount): ShareRow => {
    const key = refKey(account);
    const outcome = outcomes.value.get(key);
    const brand = providerName(account.provider);
    const named = account.label.toLowerCase().includes(brand.toLowerCase());
    const failed = outcome?.outcome === `failed`;
    // A sentence's own stop goes, since the line carries on after it.
    const what = (failed ? (outcome.message ?? t(`connect.shareAccounts.failed`)) : modeLine(account)).replace(/[.!\s]+$/u, ``);
    return {
        key,
        account,
        title: account.label,
        description: [what, named ? undefined : brand, account.email].filter((part) => part !== undefined && part !== ``).join(` · `),
        tone: failed ? `warning` : `default`,
        done: outcome?.outcome === `copied` ? t(`connect.shareAccounts.copied`) : outcome?.outcome === `borrowed` ? t(`connect.shareAccounts.borrowed`) : undefined,
        canBring: account.mode !== `no` && !broughtIn(outcome),
        signIn: isProviderTile(account.provider) ? account.provider : undefined,
    };
};

const rows = computed<readonly ShareRow[]>(() => (listing.value?.accounts ?? []).map(rowOf));
// What Bring all brings: every row that can come and has not yet, offered once there are two of them.
const remaining = computed(() => bringable(rows.value.filter((row) => row.canBring).map((row) => row.account)));
</script>

<template>
    <RowGroup v-if="shown" :label="t(`connect.shareAccounts.title`)">
        <template v-if="remaining.length > 1" #actions>
            <Button
                size="small"
                tier="boring"
                :label="t(`connect.shareAccounts.bringAll`)"
                :loading="bringing === ALL"
                :disabled="bringing !== undefined"
                @click="bring(remaining, ALL)"
            >
                <template #icon><Icon name="download" /></template>
            </Button>
        </template>

        <!-- Which sandbox to bring from: the one choice to make before anything is shown. -->
        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span class="text-xs text-muted">{{ t(`connect.shareAccounts.from`) }}</span>
                    <Picker
                        v-model="sourceId"
                        :options="sourceOptions"
                        variant="input"
                        :aria-label="t(`connect.shareAccounts.which`)"
                        :header="t(`connect.shareAccounts.which`)"
                        :placeholder="t(`connect.shareAccounts.pickOne`)"
                        class="ui-field-sm w-56"
                    />
                </div>
                <!-- What Copy and Borrow mean, which each row then names in a word. -->
                <p class="text-2xs text-subtle">{{ t(`connect.shareAccounts.explain`) }}</p>
            </div>
        </RowNote>

        <RowNote v-if="reading && source" variant="note">{{ t(`connect.shareAccounts.reading`, { name: source.name }) }}</RowNote>
        <RowNote v-else-if="readNotice" variant="block"><Notice :of="readNotice" size="sm" /></RowNote>
        <RowNote v-else-if="listing && rows.length === 0" variant="empty">{{ t(`connect.shareAccounts.nothing`, { name: listing.sandbox }) }}</RowNote>

        <Row v-for="row in rows" :key="row.key" :title="row.title" :description="row.description" :tone="row.tone">
            <template #lead="{ mark }">
                <span class="flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }"
                    ><ProviderLogo :provider="row.account.provider"
                /></span>
            </template>
            <template #control>
                <span v-if="row.done" class="flex items-center gap-1 text-2xs text-success"><Icon name="check" class="text-2xs" />{{ row.done }}</span>
                <template v-else>
                    <Button
                        v-if="row.signIn"
                        tier="quiet"
                        size="small"
                        :label="t(`connect.shareAccounts.signInHere`)"
                        :disabled="busy"
                        @click="emit(`signIn`, row.signIn)"
                    />
                    <Button
                        v-if="row.canBring"
                        tier="boring"
                        size="small"
                        :label="t(`connect.shareAccounts.bring`)"
                        :loading="bringing === row.key"
                        :disabled="bringing !== undefined"
                        @click="bring([row.account], row.key)"
                    />
                </template>
            </template>
        </Row>

        <RowNote v-if="bringNotice" variant="block">
            <Notice :of="bringNotice" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="bringOp.dismiss()" />
        </RowNote>
    </RowGroup>
</template>
