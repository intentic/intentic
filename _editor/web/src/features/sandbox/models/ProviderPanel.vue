<script setup lang="ts">
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { loopDoors, loopLabel, loopOf, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { mintedVariants, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { HubTarget } from "@intentic/sandbox-contract/schemas/connection-hub";
import { Button, ContextMenu, Icon, Notice, type NoticeModel, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, useTemplateRef } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useRole } from "../../../client/sandbox/useRole";
import { accountsOutdated } from "../../../models/providers/accountsOutdated";
import { translatorAccounts } from "../../../models/providers/providerAccounts";
import { accountsOf, subscriptionOnly } from "../../../models/conversations/accounts/useChat-accounts";
import { offeredLoops } from "../../../models/providers/offeredLoops";
import { useChat } from "../../../models/conversations/run/useChat";
import { hasSignIn } from "../../../models/providers/access";
import { accountTarget, accountWant, saveLabel } from "../../../models/hub/connectionHub";
import { useConnectionHub } from "../../../models/hub/useConnectionHub";
import { keysBeside } from "../../../models/providers/providerCatalog";
import {
    type AccountFacts,
    accountFacts,
    accountState,
    liveUsage,
    type PlanHeadroom,
    planHeadroom,
    routedAccountFacts,
} from "../../../models/providers/usageStatus";
import HubTakeOffer from "../../../parts/sandbox/HubTakeOffer.vue";
import SandboxOutdatedNotice from "../../../parts/sandbox/SandboxOutdatedNotice.vue";
import ConnectionRow from "../secrets/ConnectionRow.vue";
import EstatePicker from "../secrets/EstatePicker.vue";
import ProviderKeys from "./keys/ProviderKeys.vue";
import ConnectAttempt from "./ConnectAttempt.vue";
import { accountOffLine } from "./accountOff";
import {
    type AccountReader,
    ambiguousLabels,
    connectorNote,
    connectWays,
    identityNote,
    mayChangeAccount,
    rowNote,
    usageLine,
    waitingLine,
} from "./accountRows";

// ONE PROVIDER, opened from its tile in Sandbox ▸ Models' grid: everything about it in one card. Its accounts (who each
// one signs in as, what it is spending, what it needs, drop one), the one button that adds one, and the sign-in itself
// while it runs, at the top of the list where that button was pressed. There is no other door to a provider's sign-in on
// the page: the grid picks the provider, this panel connects it.
//
// Empty, the card is the explanation and the Connect button, as an empty persona list is its own Add button; once it holds
// an account, adding another moves to the group's header, where every list in the app keeps its "add one".
//
// Two mechanisms draw the same: a provider's own account (Claude, Cursor, Grok's xAI, the minted ones) and a subscription
// held by the bundled translator (ChatGPT, Kimi, Google, Grok under Claude Code). Which one is behind a row is the
// sandbox's business, not the reader's.

const t = useT();

const {
    provider,
    attempt,
    finishing = false,
    otherLive,
    busy = false,
    landed,
    found = false,
    notice,
    chatLabel,
} = defineProps<{
    provider: AgentProvider;
    // This provider's sign-in, when one is starting, waiting on the reader, or just failed.
    attempt?: { readonly phase: `starting` | `live` | `failed`; readonly kind?: `native` | `routed`; readonly problem?: string };
    finishing?: boolean;
    // Another provider's sign-in still waiting: starting one here replaces it, which the panel says before the press.
    otherLive?: AgentProvider;
    // A sign-in is on its way to the sandbox: no second press until it answers.
    busy?: boolean;
    // What just connected here, in a sentence naming the sandbox it went to.
    landed?: string;
    // The desktop app found this provider signed in on this computer.
    found?: boolean;
    // Something an account write here was refused for (a disconnect).
    notice?: NoticeModel;
    // The words on the press after a sign-in lands, which go to a chat: where that chat is depends on where this page is shown.
    chatLabel?: string;
}>();
// The page owns every sign-in, so there is one at a time; this panel only says which kind it wants and, for a provider
// sold under several plans, which plan.
const emit = defineEmits<{
    connect: [request: { via: `native` | `routed`; variant?: string }];
    cancel: [];
    retry: [];
    dismiss: [];
    chat: [];
    show: [provider: AgentProvider];
    dismissNotice: [];
    // An API key added beside the sign-in became this endpoint, named for its vendor.
    keyAdded: [endpoint: AgentProvider, label: string];
}>();

const spec = computed(() => providerSpec(provider));
const signingInHere = computed(() => attempt !== undefined && attempt.phase !== `failed`);

const attemptBlock = useTemplateRef<InstanceType<typeof ConnectAttempt>>(`attemptBlock`);
defineExpose({ reveal: () => attemptBlock.value?.reveal() });

const { accountBusy, accountUsage, usageLoaded, renameAccount, disconnect, disconnectTranslator, translatorKey } = useChat();

// The provider as the translator keys it, where it holds subscriptions there at all; parsed once, so every routed read
// below names a provider the translator knows rather than asserting one.
const keyed = computed<KeyedProvider | undefined>(() => {
    const parsed = KeyedProviderSchema.safeParse(provider);
    return parsed.success && providerSpec(provider)?.auth.kind === `translator` ? parsed.data : undefined;
});
const routed = computed(() => keyed.value !== undefined);
/* Codex, Kimi and Gemini own no native account: the subscription row IS their connection. */
const hasNative = computed(() => hasSignIn(provider) && !subscriptionOnly(provider));
const nativeAccounts = computed(() => (hasNative.value ? accountsOf(provider) : []));
const routedAccounts = computed(() => (keyed.value === undefined ? [] : (translatorAccounts.value[keyed.value] ?? [])));

// Which plan to sign in to, for a provider sold under several whose keys are not interchangeable (Z.ai, BigModel).
const estate = ref<string | undefined>(undefined);
// Asked only of a reader who may sign in to one.
const offersEstates = computed(() => mayStart.value.native && (mintedVariants(provider)?.length ?? 0) > 1);
// The loops this provider's own door signs in with a program of their own (Grok Build, Kimi CLI), each a separate sign-in
// from the provider's default one; a row says which by its variant. Only those this sandbox's daemon runs: an older one
// has no door to sign them in through.
const doors = computed(() => loopDoors(provider).filter((door) => offeredLoops(provider).includes(door.loop)));
const doorOf = (account: Pick<OauthAccount, `variant`>) => doors.value.find((door) => door.door === account.variant);
// Whether the provider's own door holds a default sign-in beside its loop doors: every native provider's, and Grok's
// xAI account (OpenCode's); Kimi's default credential is the translator's subscription, its own door only its CLI's.
const hasDefaultNative = computed(() => hasNative.value && (provider === `grok` || spec.value?.auth.kind !== `translator`));
// Grok holds a single default account (OpenCode owns the xAI credential); its "add another" goes once it is linked.
const canAddDefault = computed(() => provider !== `grok` || nativeAccounts.value.every((account) => doorOf(account) !== undefined));

// Who is reading, as far as changing an account goes (accountRows.ts): Full access changes every row, someone given AI
// accounts of their own only the ones they connected, and anyone else none. Below Full access the rest of the list is
// still read, so a person sees what the sandbox runs on, with no press on a row the sandbox would refuse them.
const { canShip } = useRole();
const { can, holds } = useAccess();
const { user } = useAuth();
const reader = computed<AccountReader>(() => ({ full: canShip.value, ownAccounts: holds(`ownAccounts`), email: user.value?.email }));
// The ways in the reader may start: a subscription the translator holds is Full access's alone.
const mayStart = computed(() => ({
    native: canShip.value || can(`accounts.start`, { provider }),
    routed: canShip.value || can(`translator.connect`, { provider }),
}));

// No two rows may read the same; distinguished in order: the identity the provider reports, the name (renamable in
// place), and failing both, when it was connected. Grok is exempt from renaming: OpenCode owns its one account.
const renameOf = (account: OauthAccount): ((label: string) => Promise<void>) | undefined =>
    provider === `grok` && doorOf(account) === undefined ? undefined : (label: string) => renameAccount(account.id, label, provider);

// Which loop a row's sign-in serves, said where the provider holds sign-ins for more than one: a loop door's own, or
// the default one's loop beside them.
const loopNote = (account: OauthAccount): string | undefined => {
    if (doors.value.length === 0) {
        return undefined;
    }
    const door = doorOf(account);
    return t(`sandbox.aiAccountSection.viaLoop`, { loop: loopLabel(provider, door?.loop ?? loopOf(provider, `native`)) });
};

const ambiguous = computed(() => ambiguousLabels(nativeAccounts.value));

// The connections hub (models/hub): a provider whose account is a key that does not rotate (Cursor, Devin, Z.ai,
// Meta) keeps one on the owner's computer for their other sandboxes, and an empty card takes one saved there instead of
// signing in. Every other provider is signed in to on each sandbox, and reads nothing of the hub.
const hubWant = computed(() => accountWant(provider));
const hub = useConnectionHub(() => hubWant.value !== undefined);
const hubTargets = computed(() => nativeAccounts.value.flatMap((account) => accountTarget(provider, account.id) ?? []));
const hubFailure = computed(() => hub.saveFailure(hubTargets.value));
// One computer takes the press at once; several are asked about in a menu under it.
const saveMenu = useTemplateRef<InstanceType<typeof ContextMenu>>(`saveMenu`);
const saveItems = ref<MenuItem[]>([]);
const saveToHub = ({ target, machines }: { readonly target: HubTarget; readonly machines: readonly string[] }, event: Event): void => {
    const [only] = machines;
    if (machines.length === 1 && only !== undefined) {
        void hub.save(target, only);
        return;
    }
    saveItems.value = machines.map((machine) => ({ label: machine, command: () => void hub.save(target, machine) }));
    saveMenu.value?.show(event);
};

interface AccountRow<T> {
    account: T;
    headroom: PlanHeadroom | undefined;
    state: AccountState;
    exhausted: boolean;
}

// Decorates and sorts in one pass: rows a person has to act on first (they are why a reader opens this), then active,
// then spent; an account with no reading counts as active (unknown is not exhausted). Order within each group is the
// daemon's.
const rowsOf = <T,>(accounts: readonly T[], factsOf: (account: T) => AccountFacts): AccountRow<T>[] => {
    const attention: AccountRow<T>[] = [];
    const active: AccountRow<T>[] = [];
    const spent: AccountRow<T>[] = [];
    for (const account of accounts) {
        const facts = factsOf(account);
        const state = accountState(provider, facts);
        const waiting = state.kind === `spent` || (state.kind === `blocked` && state.fix === `wait`);
        const row = { account, headroom: planHeadroom(liveUsage(provider, facts.account)), state, exhausted: waiting };
        (row.exhausted ? spent : state.kind === `blocked` ? attention : active).push(row);
    }
    return [...attention, ...active, ...spent];
};

// The status line under the name, one judgement for both mechanisms: what waiting will fix, or what a person has to do
// before it serves again. A Google account with no project needs Google's own onboarding, so that one names the door. An
// account its organization or plan turned off says so first, and since when (accountOff.ts).
const stateLine = (state: AccountState, account: { readonly id: string; readonly label: string }, signedOut: boolean): string | undefined => {
    if (state.kind !== `blocked` || state.fix === `wait`) {
        return waitingLine(state);
    }
    if (state.fix === `verify`) {
        return t(`sandbox.aiAccountSection.verifyThisAccount`, { label: account.label });
    }
    if (state.fix === `admin`) {
        return accountOffLine(provider, providerLabel(provider), account.id, state.reason);
    }
    if (signedOut) {
        return t(`sandbox.aiAccountSection.signedOutReconnectTo`);
    }
    return provider === `gemini` && state.fix === `reconnect`
        ? t(`sandbox.aiAccountSection.geminiFinishSetup`, { reason: state.reason })
        : state.reason;
};

// The row's dot by who can fix it: the person here (`reauth`), or somebody this sandbox cannot reach (`blocked`).
const connectionState = (state: AccountState): `connected` | `reauth` | `blocked` =>
    state.kind !== `blocked` || state.fix === `wait` ? `connected` : state.fix === `admin` ? `blocked` : `reauth`;

const verifyUrl = (state: AccountState): string | undefined => (state.kind === `blocked` && state.fix === `verify` ? state.url : undefined);

// Opened in a new tab: the person signs in there as that account, and this tab keeps its place.
const openVerify = (url: string): void => {
    window.open(url, `_blank`, `noopener,noreferrer`);
};

const needsReconnect = (state: AccountState): boolean => state.kind === `blocked` && state.fix === `reconnect`;

interface AccountView {
    readonly key: string;
    readonly title: string;
    readonly note: string | undefined;
    readonly description: string | undefined;
    readonly state: AccountState;
    readonly headroom: PlanHeadroom | undefined;
    readonly exhausted: boolean;
    readonly activity: string | undefined;
    readonly rename: ((label: string) => Promise<void>) | undefined;
    readonly verify: string | undefined;
    // Signing in again replaces this credential in place; only the native sign-in can.
    readonly reconnect: boolean;
    // The loop door a native row signs in through, which its Reconnect asks for again.
    readonly variant?: string | undefined;
    readonly busy: string;
    // Absent where the reader may not take it off: an account somebody else connected.
    readonly disconnect: (() => void) | undefined;
    // Where it can be kept on the owner's computer, for an account that travels; its note says so while a save is on its way.
    readonly save?: { readonly target: HubTarget; readonly machines: readonly string[] } | undefined;
    readonly noteBusy?: boolean | undefined;
}

// What a native row offers the reader: renamed, signed in again and disconnected here by whoever may change it
// (accountRows.ts `mayChangeAccount`).
type NativePresses = Pick<AccountView, `rename` | `verify` | `reconnect` | `disconnect`>;
const nativePresses = (account: OauthAccount, state: AccountState): NativePresses => {
    const changes = mayChangeAccount(account, reader.value);
    return {
        rename: changes ? renameOf(account) : undefined,
        verify: changes ? verifyUrl(state) : undefined,
        reconnect: changes && needsReconnect(state) && (doorOf(account) !== undefined || canAddDefault.value),
        disconnect: changes ? () => void disconnect(account.id, provider) : undefined,
    };
};

const nativeView = ({ account, headroom, exhausted, state }: AccountRow<OauthAccount>): AccountView => {
    // Who connected it comes last, except for a reader who changes only their own accounts, for whom it is the reason
    // this row's buttons differ from its neighbours', so it comes first.
    const connector = connectorNote(account.connectedBy, reader.value.email);
    const target = accountTarget(provider, account.id);
    const onHub = target === undefined ? undefined : hub.rowOf(target);
    const note = [
        reader.value.full ? undefined : connector,
        loopNote(account),
        identityNote(account, ambiguous.value),
        onHub?.note,
        reader.value.full ? connector : undefined,
    ];
    return {
        key: account.id,
        title: account.label,
        note: rowNote(note),
        description: stateLine(state, account, account.needsReauth === true && account.detail === undefined),
        state,
        headroom,
        exhausted,
        // Per-account spend, in the meter's card rather than on the row; withheld entirely until usage has loaded.
        activity: needsReconnect(state) || !usageLoaded.value ? undefined : usageLine(accountUsage.value[account.id]),
        ...nativePresses(account, state),
        variant: doorOf(account)?.door,
        busy: account.id,
        save: target === undefined || onHub === undefined || onHub.saveTo.length === 0 ? undefined : { target, machines: onHub.saveTo },
        noteBusy: onHub?.busy,
    };
};
const nativeViews = computed<readonly AccountView[]>(() => rowsOf(nativeAccounts.value, accountFacts).map(nativeView));

// A subscription is held by the translator, which only Full access signs in to or out of.
const routedChanges = computed(() => canShip.value || can(`translator.disconnect`, { provider }));
// A subscription is named by whoever signs in to it (the translator's label is that email). Only a provider that can hold
// both kinds side by side (Grok, Kimi) says which kind this is.
const routedViews = computed<readonly AccountView[]>(() =>
    rowsOf(routedAccounts.value, routedAccountFacts).map(({ account, headroom, exhausted, state }) => ({
        key: `${provider}:${account.name}`,
        title: account.label,
        note: hasNative.value ? t(`sandbox.aiAccountSection.viaClaudeCode`) : undefined,
        description: stateLine(state, { id: account.name, label: account.label }, false),
        state,
        headroom,
        exhausted,
        activity: undefined,
        rename: undefined,
        verify: routedChanges.value ? verifyUrl(state) : undefined,
        reconnect: false,
        busy: translatorKey(provider, account.name),
        disconnect: routedChanges.value
            ? () => {
                  if (keyed.value !== undefined) {
                      void disconnectTranslator(keyed.value, account.name);
                  }
              }
            : undefined,
    })),
);

// Collapses beyond COLLAPSE_THRESHOLD rows, so a provider holding thirty accounts does not push its own sign-in a
// screen down.
const COLLAPSE_THRESHOLD = 5;
const VISIBLE_WHEN_COLLAPSED = 3;
const expanded = ref(false);
const rows = computed(() => [
    ...nativeViews.value.map((row) => ({ ...row, via: `native` as const })),
    ...routedViews.value.map((row) => ({ ...row, via: `routed` as const })),
]);
// A vendor's API key is a connection here too (ProviderKeys), so a card holding only a key is not an empty one.
const holdsAny = computed(() => rows.value.length > 0 || keysBeside(provider).length > 0);
const shouldCollapse = computed(() => rows.value.length > COLLAPSE_THRESHOLD);
const shownRows = computed(() => (shouldCollapse.value && !expanded.value ? rows.value.slice(0, VISIBLE_WHEN_COLLAPSED) : rows.value));

const providerName = computed(() => spec.value?.accountLabel ?? provider);

// What each way in is called, for the buttons that name it (accountRows.ts `connectWays`): Grok's three (its own xAI
// account, Grok Build's sign-in, a SuperGrok subscription under Claude Code) and Kimi's two (Kimi CLI's sign-in, the
// subscription).
const ROUTED_NAME = computed(
    () =>
        ({
            codex: t(`sandbox.aiAccountSection.chatgptSubscription`),
            grok: t(`sandbox.aiAccountSection.underClaudeCode`),
            kimi: t(`sandbox.aiAccountSection.kimiCodeSubscription`),
            gemini: t(`sandbox.aiAccountSection.googleAccount`),
        }) satisfies Record<KeyedProvider, string>,
);
const ways = computed(() =>
    connectWays({
        native: hasDefaultNative.value
            ? {
                  // Beside a loop's own sign-in, the default one says which loop it serves too (Grok's: OpenCode).
                  name:
                      doors.value.length === 0
                          ? t(`sandbox.aiAccountSection.account`, { managedLabel: providerName.value })
                          : t(`sandbox.aiAccountSection.accountViaLoop`, { managedLabel: providerName.value, loop: loopLabel(provider, loopOf(provider, `native`)) }),
                  addable: canAddDefault.value,
              }
            : undefined,
        doors: hasNative.value ? doors.value.map((door) => ({ door: door.door, name: t(`sandbox.aiAccountSection.loopSignIn`, { loop: loopLabel(provider, door.loop) }) })) : [],
        routed: keyed.value === undefined ? undefined : ROUTED_NAME.value[keyed.value],
        may: mayStart.value,
        empty: rows.value.length === 0,
    }),
);

// What the empty card says: that connecting this one is Full access's, or what signing in takes.
const emptyLine = computed(() => {
    if (ways.value.length === 0 && !canShip.value) {
        return t(`connect.providerPanel.emptyFullAccess`);
    }
    return found ? t(`connect.connect.foundSignedIn`) : t(`connect.providerPanel.empty`);
});

// A loop door's way names its own variant; the default native way names the estate, where the provider sells several.
const ask = (via: `native` | `routed`, variant?: string): void =>
    emit(`connect`, variant !== undefined ? { via, variant } : via === `native` && offersEstates.value ? { via, variant: estate.value } : { via });
const otherName = computed(() => (otherLive === undefined ? `` : (providerSpec(otherLive)?.accountLabel ?? otherLive)));
</script>

<template>
    <RowGroup :label="providerName">
        <!-- Adding one more is the list's own action, where every list keeps it; with nothing in the list, the card says it. -->
        <template v-if="holdsAny && !signingInHere && ways.length > 0" #actions>
            <Button v-for="way in ways" :key="way.key" size="small" tier="boring" :label="way.label" :disabled="busy" @click="ask(way.via, way.variant)">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <!-- The one thing that just happened here, with the one next move. -->
        <RowNote v-if="landed" variant="block">
            <div class="flex flex-wrap items-center gap-3">
                <Icon name="check" class="shrink-0 text-success" />
                <span class="min-w-0 flex-1 text-sm text-content">{{ landed }}</span>
                <Button tier="accent" size="small" :label="chatLabel ?? t(`connect.connect.startChatting`)" @click="emit(`chat`)" />
            </div>
        </RowNote>

        <RowNote v-if="notice" variant="block">
            <Notice :of="notice" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="emit(`dismissNotice`)" />
        </RowNote>
        <RowNote v-if="hubFailure" variant="block">
            <Notice :of="hubFailure" size="sm" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="hub.dismissSaves(hubTargets)" />
        </RowNote>

        <!-- A sandbox too old to judge its accounts: every row reads unknown, and this says why and how to update. -->
        <RowNote v-if="accountsOutdated && rows.length > 0" variant="block">
            <SandboxOutdatedNotice :missing="t(`sandbox.aiAccountSection.outdatedMissing`)" />
        </RowNote>

        <!-- With accounts already here, a provider sold under several plans asks which one the next account is on: under
             the Add button it is asked for, not after the list. -->
        <RowNote v-if="rows.length > 0 && offersEstates && attempt === undefined" variant="block">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span class="text-xs text-muted">{{ t(`connect.connect.whichPlan`) }}</span>
                <EstatePicker v-model="estate" :provider="provider" :label="t(`connect.connect.whichPlan`)" />
            </div>
        </RowNote>

        <!-- The sign-in takes the place of the press that started it: first under the header, its own button (Open Google)
             right below where Add stood. At the foot of the list it opened a screen away from the press, after every row. -->
        <RowNote v-if="attempt" variant="block">
            <ConnectAttempt
                ref="attemptBlock"
                :provider="provider"
                :phase="attempt.phase"
                :kind="attempt.kind"
                :problem="attempt.problem"
                :finishing="finishing"
                @cancel="emit(`cancel`)"
                @retry="emit(`retry`)"
                @dismiss="emit(`dismiss`)"
            />
        </RowNote>

        <!-- One sign-in at a time: said before the press that would end the other one, with the way back to it. -->
        <RowNote v-else-if="otherLive" variant="note" icon="info-circle">
            <span>{{ t(`connect.providerPanel.otherLive`, { other: otherName, provider: providerName }) }}</span>
            <button type="button" :class="ui.textButton(`ml-2`)" @click="emit(`show`, otherLive)">
                {{ t(`connect.providerPanel.showOther`, { other: otherName }) }}
            </button>
        </RowNote>

        <ConnectionRow
            v-for="row in shownRows"
            :key="row.key"
            :title="row.title"
            :state="connectionState(row.state)"
            :tone="row.state.kind === `blocked` && row.state.fix !== `wait` ? `warning` : `default`"
            :note="row.note"
            :note-busy="row.noteBusy"
            :description="row.description"
            :activity="row.activity"
            :rename="row.rename"
            :headroom="row.headroom"
            :exhausted="row.exhausted"
        >
            <template #control>
                <!-- The fix is the account owner's, on the provider's page: the one action this row wants. -->
                <Button tier="accent" v-if="row.verify !== undefined" :label="t(`sandbox.aiAccountSection.verify`)" size="small" @click="openVerify(row.verify)">
                    <template #icon><Icon name="external-link" /></template>
                </Button>
                <Button
                    tier="accent"
                    v-else-if="row.reconnect && !signingInHere"
                    :label="t(`ui.action.reconnect`)"
                    size="small"
                    :disabled="busy"
                    @click="ask(row.via, row.variant)"
                />
                <!-- Kept on the owner's computer for their other sandboxes: the one computer by name, or a pick when there are several. -->
                <Button
                    v-if="row.save"
                    :label="saveLabel(row.save.machines)"
                    size="small"
                    tier="quiet"
                    :disabled="row.noteBusy"
                    :aria-haspopup="row.save.machines.length > 1 ? `menu` : undefined"
                    @click="saveToHub(row.save, $event)"
                >
                    <template #icon><Icon name="desktop" /></template>
                </Button>
                <Button
                    v-if="row.disconnect"
                    :label="t(`ui.action.disconnect`)"
                    size="small"
                    tier="quiet"
                    tone="danger"
                    :loading="accountBusy === row.busy"
                    @click="row.disconnect()"
                />
            </template>
        </ConnectionRow>
        <ContextMenu ref="saveMenu" :model="saveItems" :min-width="8" />

        <RowNote
            v-if="shouldCollapse"
            variant="action"
            :icon="expanded ? `chevron-up` : `chevron-down`"
            :label="
                expanded
                    ? t(`ui.action.showLess`)
                    : t(`sandbox.aiAccountSection.showMoreAccounts`, { collapsedCount: rows.length - VISIBLE_WHEN_COLLAPSED })
            "
            @click="expanded = !expanded"
        />

        <!-- Nothing here yet: what connecting needs, and the button that does it. -->
        <RowNote v-if="!holdsAny && attempt === undefined" variant="block">
            <div class="flex flex-col items-start gap-3">
                <p class="text-xs text-muted">{{ emptyLine }}</p>
                <!-- The plan is the sign-in's own first step, so it is asked beside the button, before anything starts. -->
                <EstatePicker v-if="offersEstates" v-model="estate" :provider="provider" :label="t(`connect.connect.whichPlan`)" />
                <div v-if="ways.length > 0 || hubWant" class="flex flex-wrap items-start gap-2">
                    <Button
                        v-for="(way, index) in ways"
                        :key="way.key"
                        :tier="index === 0 ? `accent` : `boring`"
                        size="small"
                        :label="way.label"
                        :disabled="busy"
                        @click="ask(way.via, way.variant)"
                    >
                        <template #icon><Icon name="sign-in" /></template>
                    </Button>
                    <!-- Saved on the owner's computer from another of their sandboxes: the alternative to signing in here. -->
                    <HubTakeOffer v-if="hubWant" :want="hubWant" :disabled="busy" />
                </div>
            </div>
        </RowNote>

        <!-- The vendor's keys after the accounts, else the deliberate alternative to signing in, offered to Full access alone. -->
        <ProviderKeys :provider="provider" :offer="canShip && !signingInHere" @added="(endpoint, label) => emit(`keyAdded`, endpoint, label)" />
    </RowGroup>
</template>
