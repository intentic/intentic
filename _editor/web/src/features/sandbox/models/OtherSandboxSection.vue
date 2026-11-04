<!-- One of the owner's other sandboxes in "From your other sandboxes" (BringAccounts.vue): its name and whether it is linked here, then either the Link step (with what linking would offer, said in one line) or, once linked, its accounts one row per provider. Whatever a press here could not do is said at the top of this section, in the daemon's words. -->
<script setup lang="ts">
import { isEndpointProvider, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { type NativeProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { BorrowOutcome, ShareableAccount } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { Button, DisclosureRow, Icon, Notice, type NoticeModel, RowGroup, StatusBadge } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import { byProvider, type OtherAccount } from "./otherAccounts";
import { isProviderTile } from "./providerGrid";
import { broughtIn } from "./shareAccounts";
import { groupTag, linkTag, type SourceSection, taggedFor } from "./useOtherAccounts";

const t = useT();

const {
    section,
    outcomes,
    bringing,
    failure,
    failureTag,
    busy = false,
    linkTier = `accent`,
} = defineProps<{
    section: SourceSection;
    outcomes: ReadonlyMap<string, BorrowOutcome>;
    // The tag of the press under way anywhere in the dialog: one at a time.
    bringing: string | undefined;
    failure: NoticeModel | undefined;
    failureTag: string | undefined;
    // A sign-in is on its way to the sandbox: no second one from here until it answers.
    busy?: boolean;
    // Link is the one step forward while one sandbox waits on it; beside a second, it is one tool among two.
    linkTier?: `accent` | `boring`;
}>();
const emit = defineEmits<{
    link: [];
    bring: [rows: readonly OtherAccount[], tag: string];
    signIn: [provider: NativeProvider];
    dismiss: [];
}>();

const name = computed(() => section.source.name);
const linked = computed(() => section.link.state === `linked`);

const providerName = (provider: string): string =>
    isEndpointProvider(provider) ? t(`connect.shareAccounts.endpoint`) : (providerSpec(provider)?.accountLabel ?? providerLabel(provider));

// How it would come here: the mode's word, or why it cannot come. A sentence's own stop goes, since the line carries on.
const modeLine = (account: ShareableAccount): string =>
    (account.mode === `copy`
        ? t(`connect.shareAccounts.modeCopy`)
        : account.mode === `lend`
          ? t(`connect.shareAccounts.modeLend`)
          : (account.reason ?? t(`connect.shareAccounts.modeNo`))
    ).replace(/[.!\s]+$/u, ``);

const outcomeOf = (row: OtherAccount): BorrowOutcome | undefined => outcomes.get(row.key);
const canBring = (row: OtherAccount): boolean => row.account.mode !== `no` && !broughtIn(outcomeOf(row));
const doneWord = (row: OtherAccount): string | undefined => {
    const outcome = outcomeOf(row)?.outcome;
    return outcome === `copied` ? t(`connect.shareAccounts.copied`) : outcome === `borrowed` ? t(`connect.shareAccounts.borrowed`) : undefined;
};

// One row per provider: what it is, how its accounts come, how many are here already and the press that brings the rest.
interface ProviderGroup {
    readonly provider: string;
    readonly title: string;
    readonly description: string;
    readonly rows: readonly OtherAccount[];
    readonly waiting: readonly OtherAccount[];
    readonly done: string | undefined;
    // The provider whose own sign-in this page can start, for accounts that cannot come.
    readonly signIn: NativeProvider | undefined;
}

const accountLine = (account: ShareableAccount, brand: string): string => {
    const named = account.label.toLowerCase().includes(brand.toLowerCase());
    return [named ? account.label : `${brand} · ${account.label}`, account.email].filter((part) => part !== undefined && part !== ``).join(` · `);
};

const groups = computed<readonly ProviderGroup[]>(() =>
    byProvider(section.rows).map(({ provider, rows }) => {
        const brand = providerName(provider);
        const firstRow = rows[0];
        const first = firstRow?.account;
        const waiting = rows.filter(canBring);
        const able = rows.filter((row) => row.account.mode !== `no`);
        const here = able.length - waiting.length;
        const single = rows.length === 1 && firstRow !== undefined;
        return {
            provider,
            title: single ? accountLine(firstRow.account, brand) : t(`connect.shareAccounts.groupTitle`, { provider: brand, count: rows.length }, rows.length),
            description: first === undefined ? `` : modeLine(first),
            rows,
            waiting,
            done:
                able.length === 0 || waiting.length > 0
                    ? here > 0
                        ? t(`connect.shareAccounts.someHere`, { count: here, total: able.length })
                        : undefined
                    : single
                      ? doneWord(firstRow)
                      : t(`connect.shareAccounts.allHereCount`, { count: here }),
            signIn: able.length === 0 && isProviderTile(provider) ? provider : undefined,
        };
    }),
);
const open = ref<ReadonlySet<string>>(new Set());
const toggle = (provider: string, to: boolean): void => {
    const next = new Set(open.value);
    if (to) {
        next.add(provider);
    } else {
        next.delete(provider);
    }
    open.value = next;
};

// Before Link: what it would offer, by provider, so a press is never a leap into the unknown.
const summary = computed(() =>
    byProvider(section.rows)
        .map(({ provider, rows }) => (rows.length > 1 ? `${providerName(provider)} ×${rows.length}` : providerName(provider)))
        .join(`, `),
);

const waitingAll = computed(() => groups.value.flatMap((group) => group.waiting));
const failedHere = computed(() => section.rows.filter((row) => outcomeOf(row)?.outcome === `failed`));
// What the last press brought back failed, said once for the section: how many, and the daemon's own reasons.
const failedNotice = computed<NoticeModel | undefined>(() => {
    if (failedHere.value.length === 0) {
        return undefined;
    }
    const reasons = [...new Set(failedHere.value.map((row) => outcomeOf(row)?.message ?? t(`connect.shareAccounts.failed`)))];
    return {
        tone: `warning`,
        title: t(`connect.shareAccounts.someFailed`, { count: failedHere.value.length, name: name.value }, failedHere.value.length),
        detail: reasons.join(` `),
    };
});
const pressFailure = computed(() => (failure !== undefined && taggedFor(failureTag, section.source.id) ? failure : undefined));
const linkFailed = computed(() => pressFailure.value !== undefined && failureTag === linkTag(section.source.id));

const badge = computed<{ variant: `success` | `warning` | `neutral`; label: string }>(() => {
    switch (section.link.state) {
        case `linked`:
            return { variant: `success`, label: t(`connect.shareAccounts.stateLinked`) };
        case `revoked`:
        case `silent`:
            return { variant: `warning`, label: section.link.state === `revoked` ? t(`connect.shareAccounts.stateRevoked`) : t(`connect.shareAccounts.stateSilent`) };
        default:
            return { variant: `neutral`, label: t(`connect.shareAccounts.stateUnlinked`) };
    }
});
const linkLabel = computed(() =>
    section.link.state === `unlinked` ? t(`connect.shareAccounts.link`, { name: name.value }) : section.link.state === `revoked` ? t(`connect.shareAccounts.linkAgain`) : t(`connect.shareAccounts.checkAgain`),
);
</script>

<template>
    <RowGroup>
        <template #label>
            <span class="flex items-center gap-2">{{ name }}<StatusBadge :variant="badge.variant" size="xs" :label="badge.label" /></span>
        </template>
        <template #actions>
            <Button
                v-if="!linked"
                :tier="linkTier"
                size="small"
                :label="linkLabel"
                :loading="bringing === linkTag(section.source.id)"
                :disabled="bringing !== undefined"
                @click="emit(`link`)"
            />
            <!-- Everything this sandbox can still send, once more than one provider waits on it. -->
            <Button
                v-else-if="groups.filter((group) => group.waiting.length > 0).length > 1"
                tier="boring"
                size="small"
                :label="t(`connect.shareAccounts.bringAll`, { count: waitingAll.length })"
                :loading="bringing === groupTag(section.source.id)"
                :disabled="bringing !== undefined"
                @click="emit(`bring`, waitingAll, groupTag(section.source.id))"
            >
                <template #icon><Icon name="download" /></template>
            </Button>
        </template>
        <template #lead>
            <Notice v-if="pressFailure" :of="pressFailure" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismiss`)" />
            <template v-if="!linkFailed">
                <Notice v-if="section.link.state === `unlinked`" tone="info" size="sm">
                    {{ t(`connect.shareAccounts.linkFirst`, { count: section.rows.length, providers: summary, name }, section.rows.length) }}
                </Notice>
                <Notice v-else-if="section.link.state === `revoked`" tone="warning" size="sm">{{ t(`connect.shareAccounts.revoked`, { name }) }}</Notice>
                <Notice v-else-if="section.link.state === `silent`" tone="warning" size="sm">
                    {{ t(`connect.shareAccounts.silent`, { name }) }}
                    <span v-if="section.link.detail" class="block opacity-80">{{ section.link.detail }}</span>
                </Notice>
            </template>
            <Notice v-if="linked && failedNotice" :of="failedNotice" size="sm" />
        </template>

        <template v-if="linked">
            <!-- A provider with one account here is a plain row: nothing behind it to open. -->
            <DisclosureRow
                v-for="group in groups"
                :key="group.provider"
                :title="group.title"
                :description="group.description"
                :open="open.has(group.provider)"
                hit="pair"
                :disabled="group.rows.length < 2"
                :toggle-label="group.title"
                @update:open="(to: boolean) => toggle(group.provider, to)"
            >
                <template #lead="{ mark }">
                    <span class="flex shrink-0 items-center justify-center text-base text-muted" :style="{ width: `${mark}px` }"
                        ><ProviderLogo :provider="group.provider"
                    /></span>
                </template>
                <template #control>
                    <span v-if="group.done && group.waiting.length === 0" class="flex items-center gap-1 text-2xs text-success"
                        ><Icon name="check" class="text-2xs" />{{ group.done }}</span
                    >
                    <template v-else>
                        <span v-if="group.done" class="text-2xs text-muted">{{ group.done }}</span>
                        <Button
                            v-if="group.signIn"
                            tier="quiet"
                            size="small"
                            :label="t(`connect.shareAccounts.signInHere`)"
                            :disabled="busy"
                            @click="emit(`signIn`, group.signIn)"
                        />
                        <Button
                            v-if="group.waiting.length > 0"
                            tier="boring"
                            size="small"
                            :label="group.waiting.length > 1 ? t(`connect.shareAccounts.bringCount`, { count: group.waiting.length }) : t(`connect.shareAccounts.bring`)"
                            :loading="bringing === groupTag(section.source.id, group.provider)"
                            :disabled="bringing !== undefined"
                            @click="emit(`bring`, group.waiting, groupTag(section.source.id, group.provider))"
                        />
                    </template>
                </template>
                <!-- A provider's accounts one by one, for a reader who wants only some of them. -->
                <template v-if="group.rows.length > 1" #below>
                    <ul class="flex flex-col gap-1.5 py-1 text-xs">
                        <li v-for="row in group.rows" :key="row.key" class="flex items-center gap-2">
                            <span class="min-w-0 flex-1 truncate">{{ accountLine(row.account, providerName(group.provider)) }}</span>
                            <span v-if="doneWord(row)" class="flex items-center gap-1 text-2xs text-success"><Icon name="check" class="text-2xs" />{{ doneWord(row) }}</span>
                            <Button
                                v-else-if="canBring(row)"
                                tier="quiet"
                                size="small"
                                :label="t(`connect.shareAccounts.bring`)"
                                :loading="bringing === row.key"
                                :disabled="bringing !== undefined"
                                @click="emit(`bring`, [row], row.key)"
                            />
                        </li>
                    </ul>
                </template>
            </DisclosureRow>
        </template>
    </RowGroup>
</template>
