<!-- Sandbox ▸ Models' "From your other sandboxes": every model account the owner's other sandboxes hold that this one does not, read without being asked, each brought in here the way that is safe for it, without signing in again. -->
<script setup lang="ts">
import { isEndpointProvider, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { type NativeProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { ShareableAccount } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { Button, Icon, Notice, Row, RowGroup, RowNote, type RowTone, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import SandboxOutdatedNotice from "../../../parts/sandbox/SandboxOutdatedNotice.vue";
import type { OtherAccount } from "./otherAccounts";
import { isProviderTile } from "./providerGrid";
import { bringable, broughtIn } from "./shareAccounts";
import { useBringOther, useOtherAccounts } from "./useOtherAccounts";

const t = useT();

const { busy = false } = defineProps<{
    // A sign-in is on its way to the sandbox: no second one from here until it answers.
    busy?: boolean;
}>();
// Signing in here instead is the page's one sign-in (SandboxModels.vue `connect`), not a door of this section's own.
const emit = defineEmits<{ signIn: [provider: NativeProvider] }>();

const { relevant, canBorrowHere, offline, reading, rows: others, missed, outcomes, refresh } = useOtherAccounts();
const { bring, bringing, bringingAll, notice: bringNotice, dismiss } = useBringOther();

// A row per account: what it is, where it is and how it would come here, and what a press here did to it.
interface ShareRow {
    readonly other: OtherAccount;
    readonly description: string;
    readonly tone: RowTone;
    // Copied or Borrowed, once a press this visit brought it in.
    readonly done: string | undefined;
    readonly canBring: boolean;
    // The provider whose own sign-in this page can start, for an account that cannot come.
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

const rowOf = (other: OtherAccount): ShareRow => {
    const { account, source } = other;
    const outcome = outcomes.value.get(other.key);
    const brand = providerName(account.provider);
    const named = account.label.toLowerCase().includes(brand.toLowerCase());
    const failed = outcome?.outcome === `failed`;
    // A sentence's own stop goes, since the line carries on after it.
    const what = (failed ? (outcome.message ?? t(`connect.shareAccounts.failed`)) : modeLine(account)).replace(/[.!\s]+$/u, ``);
    return {
        other,
        description: [what, t(`connect.shareAccounts.on`, { name: source.name }), named ? undefined : brand, account.email]
            .filter((part) => part !== undefined && part !== ``)
            .join(` · `),
        tone: failed ? `warning` : `default`,
        done: outcome?.outcome === `copied` ? t(`connect.shareAccounts.copied`) : outcome?.outcome === `borrowed` ? t(`connect.shareAccounts.borrowed`) : undefined,
        canBring: account.mode !== `no` && !broughtIn(outcome),
        signIn: account.mode === `no` && isProviderTile(account.provider) ? account.provider : undefined,
    };
};

const rows = computed<readonly ShareRow[]>(() => others.value.map(rowOf));
// What Bring all brings: every row that can come and has not yet, offered once there are two of them.
const remaining = computed(() => {
    const open = new Set(bringable(rows.value.filter((row) => row.canBring).map((row) => row.other.account)));
    return rows.value.filter((row) => open.has(row.other.account)).map((row) => row.other);
});
const names = (sandboxes: readonly { readonly name: string }[]): string => sandboxes.map((sandbox) => sandbox.name).join(`, `);
const unreachable = computed(() => names(missed.value.unreachable));
const tooOld = computed(() => names(missed.value.tooOld));
const stopped = computed(() => names(offline.value));
// Every sandbox answered, and none holds anything this one lacks: said once, so the section never just vanishes.
const allHere = computed(() => !reading.value && rows.value.length === 0 && unreachable.value === `` && tooOld.value === ``);
</script>

<template>
    <RowGroup v-if="relevant" :label="t(`connect.shareAccounts.title`)">
        <template v-if="canBorrowHere && remaining.length > 1" #actions>
            <Button
                size="small"
                tier="boring"
                :label="t(`connect.shareAccounts.bringAll`)"
                :loading="bringingAll"
                :disabled="bringing !== undefined"
                @click="bring(remaining)"
            >
                <template #icon><Icon name="download" /></template>
            </Button>
        </template>

        <!-- This sandbox is too old to bring anything in: said, with how to update, rather than leaving the section out. -->
        <RowNote v-if="!canBorrowHere" variant="block">
            <SandboxOutdatedNotice :missing="t(`connect.shareAccounts.outdatedHere`)" />
        </RowNote>

        <template v-else>
            <RowNote v-if="reading && rows.length === 0" variant="note">{{ t(`connect.shareAccounts.looking`) }}</RowNote>
            <RowNote v-else-if="allHere" variant="note" icon="check">{{ t(`connect.shareAccounts.allHere`) }}</RowNote>

            <Row v-for="row in rows" :key="row.other.key" :title="row.other.account.label" :description="row.description" :tone="row.tone">
                <template #lead="{ mark }">
                    <span class="flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }"
                        ><ProviderLogo :provider="row.other.account.provider"
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
                            :loading="bringing === row.other.key"
                            :disabled="bringing !== undefined"
                            @click="bring([row.other], row.other.key)"
                        />
                    </template>
                </template>
            </Row>

            <RowNote v-if="bringNotice" variant="block">
                <Notice :of="bringNotice" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismiss()" />
            </RowNote>

            <!-- What Copy and Borrow mean, which each row then names in a word. -->
            <RowNote v-if="rows.some((row) => row.canBring)" variant="note">
                <span class="text-2xs text-subtle">{{ t(`connect.shareAccounts.explain`) }}</span>
            </RowNote>

            <!-- The sandboxes it could not see into, each said once with what would let it, so nothing is missing unexplained. -->
            <RowNote v-if="unreachable" variant="note" icon="exclamation-triangle" tone="warning">
                <span>{{ t(`connect.shareAccounts.unreachable`, { names: unreachable }) }}</span>
                <button type="button" :class="ui.textButton(`ml-2`)" @click="refresh(true)">{{ t(`ui.action.retry`) }}</button>
            </RowNote>
            <RowNote v-if="tooOld" variant="note" icon="info-circle">{{ t(`connect.shareAccounts.tooOldThere`, { names: tooOld }) }}</RowNote>
        </template>
        <RowNote v-if="stopped" variant="note" icon="info-circle">{{ t(`connect.shareAccounts.notRunning`, { names: stopped }) }}</RowNote>
    </RowGroup>
</template>
