<script setup lang="ts">
import { Button, Notice, type NoticeModel, StatusBadge, type StatusVariant } from "@intentic/ui";
import { computed, ref } from "vue";
import CatalogDetail from "../../../components/CatalogDetail.vue";
import { type DiscoverListing, type InstallOutcome, splitListingName } from "../../../models/sandbox/discoverListing";
import DiscoverTrust from "./DiscoverTrust.vue";
import { INSTALLS } from "./installsInFlight";
import { operationAt } from "../../../workbench/operations/operations";
import WaitProgress from "../../../components/WaitProgress.vue";
import { useWaitClock } from "../../../components/useWaitClock";
import { useT } from "@intentic/ui/i18n";

// One listing, read before it's run, opened where the Browse grid stood, the way Capabilities opens a tile: where this
// product's trust argument gets made explicit rather than implied (DiscoverTrust, docked beside the actions on a wide
// pane). The owner's own agent read is offered as primary where no human has reviewed the code, secondary otherwise. An
// unaudited commit installs only after the owner ticks that they know nobody checked it. Once an install from here
// finishes, the page becomes its receipt rather than leaving the reader: what came of it, and the way to where it now
// lives.

const t = useT();

const { listing, canInstall, installing, outcome } = defineProps<{
    listing: DiscoverListing;
    /** Installing is the owner's alone; everyone else browses. */
    canInstall: boolean;
    installing: boolean;
    failure?: NoticeModel | undefined;
    /** What the install or update just made from this panel came to. */
    outcome?: InstallOutcome | undefined;
}>();

const emit = defineEmits<{ install: []; audit: []; reveal: []; back: [] }>();

const name = computed(() => splitListingName(listing.entry.name));
const verified = computed(() => listing.entry.trust === `verified`);
const ref40 = computed(() => listing.entry.install?.ref);
const shortRef = computed(() => ref40.value?.slice(0, 10));

// Offered exactly when there's a commit to read; everything else on the panel renders regardless of installability.
const auditable = computed(() => ref40.value !== undefined && listing.state.kind !== `blocked`);
const actionable = computed(() => listing.state.action !== undefined && canInstall);
// Leads wherever the registry hasn't vouched for the code.
const auditLeads = computed(() => auditable.value && !verified.value);

const unaudited = computed(() => listing.state.unaudited === true);
const acknowledged = ref(false);

// The receipt's sentence: started, started switched off, or installed without starting in this browser.
const receipt = computed<string | undefined>(() => {
    if (outcome === undefined || outcome.problem !== undefined) {
        return undefined;
    }
    if (outcome.verb === `install`) {
        return t(`sandbox.discoverDetail.installedRunning`);
    }
    return outcome.off ? t(`sandbox.discoverDetail.updatedSwitchedOff`) : t(`sandbox.discoverDetail.updatedRunning`);
});
const notStarted = computed<NoticeModel | undefined>(() =>
    outcome?.problem === undefined
        ? undefined
        : {
              tone: `warning`,
              title: outcome.verb === `install` ? t(`sandbox.discoverDetail.installedNotStarted`) : t(`sandbox.discoverDetail.updatedNotStarted`),
              detail: outcome.problem,
          },
);
// Where a listing that is here can be managed; the Installed pill is one click away, so it is offered as one.
const revealable = computed(() => outcome !== undefined || listing.state.kind === `installed`);
// The way on only where there is nothing to install and no read to lead with; beside either, it steps back.
const revealLeads = computed(() => !actionable.value && !auditLeads.value);
// Where it stands here, as the heading's badge: the one state that describes the whole page.
const badge = computed<{ variant: StatusVariant; label: string } | undefined>(() => {
    switch (listing.state.kind) {
        case `installed`:
            return { variant: `success`, label: t(`sandbox.discoverCard.installed`) };
        case `update`:
            return listing.state.unaudited
                ? { variant: `warning`, label: t(`sandbox.discoverCard.unauditedUpdate`) }
                : { variant: `info`, label: t(`sandbox.discoverCard.update`) };
        case `blocked`:
            return { variant: `danger`, label: t(`shared.blocked`) };
        default:
            return undefined;
    }
});
// The install or update running for this listing, read off the ledger (installsInFlight.ts): a clone and an install
// out in the sandbox, which on a big extension takes minutes. Said beneath the held button with how long it has run.
const run = computed(() => (installing ? operationAt(`${INSTALLS}/${listing.entry.name}`) : undefined));
const installWait = useWaitClock(() => (run.value?.state === `running` ? run.value.startedAt : undefined));
const installWhat = computed(() =>
    listing.state.kind === `update` ? t(`sandbox.discoverDetail.updatingWhat`) : t(`sandbox.discoverDetail.installingWhat`),
);

const actionLabel = computed(() => {
    if (!unaudited.value) {
        return listing.state.action;
    }
    return listing.state.kind === `update` ? t(`sandbox.discoverDetail.updateAnyway`) : t(`sandbox.discoverDetail.installAnyway`);
});
</script>

<template>
    <CatalogDetail
        :back="t(`ui.action.browse`)"
        :name="name.title"
        :prefix="name.publisher || undefined"
        :art="listing.entry.art"
        :logo="listing.entry.logo"
        :icon="listing.entry.icon"
        :idle="listing.state.kind === `blocked` || listing.state.kind === `unavailable`"
        @back="emit(`back`)"
    >
        <template v-if="badge" #badge>
            <StatusBadge size="xs" :dot="true" :variant="badge.variant" :label="badge.label" />
        </template>

        <div class="flex flex-col gap-4">
            <p v-if="listing.entry.description" class="text-sm leading-relaxed text-muted">{{ listing.entry.description }}</p>

            <!-- Plain facts only (name, cost, popularity); anything that's a safety claim is stated in full in the trust record. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span v-if="listing.entry.version">{{ listing.entry.version }}</span>
                <span v-if="listing.entry.stars !== undefined" class="inline-flex items-center gap-0.5"
                    ><Icon name="star" />{{ listing.entry.stars }}</span
                >
                <span v-if="listing.entry.category">{{ listing.entry.category }}</span>
                <a
                    v-if="listing.entry.homepage"
                    :href="listing.entry.homepage"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex items-center gap-1 text-link hover:underline"
                >
                    {{ t(`sandbox.discoverDetail.homepage`) }} <Icon name="external-link" />
                </a>
            </div>

            <!-- The receipt replaces the state line: right after an install, "already installed" would read as a refusal. -->
            <Notice v-if="receipt" tone="success" role="status">
                {{ receipt }}
                <template v-if="outcome?.settings && !outcome.off">{{ t(`sandbox.discoverDetail.hasSettings`) }}</template>
            </Notice>
            <Notice v-else-if="notStarted" :of="notStarted" />
            <!-- A non-default state is said before anything else, so a reader never has to reach the button to learn it. -->
            <Notice v-else-if="listing.state.kind === `blocked`" tone="danger">
                <b>{{ t(`sandbox.discoverDetail.blocked`) }}</b> {{ listing.state.reason }} {{ t(`sandbox.discoverDetail.staysListedRatherThan`) }}
            </Notice>
            <Notice v-else-if="listing.state.kind === `unavailable`" tone="info">{{ listing.state.reason }}</Notice>
            <Notice v-else-if="unaudited" tone="warning">
                <b>{{ t(`sandbox.discoverDetail.notSecurityAudited`) }}</b> {{ t(`sandbox.discoverDetail.exactCommitNotPassed`) }}
                {{ t(`sandbox.discoverDetail.canStillInstall`) }}
            </Notice>
            <Notice v-else-if="listing.state.kind === `installed`" tone="info">
                {{ t(`sandbox.discoverDetail.alreadyInstalledInSandbox`) }}
            </Notice>
            <Notice v-if="outcome === undefined && listing.state.kind === `update`" tone="info">
                {{ t(`sandbox.discoverDetail.installedAt`) }} <code class="ui-code">{{ listing.state.installedRef?.slice(0, 10) }}</code
                >. The listing points at <code class="ui-code">{{ shortRef }}</code
                >. Updating replaces the code wholesale and re-asks for broader declared host API access; code internals still need review.
            </Notice>

            <!-- Inline below @3xl, before the actions, so the argument is read before the button; docked beside them above it. -->
            <DiscoverTrust :listing="listing" class="@3xl:hidden" />

            <!-- The explicit yes an unaudited install waits on, stated as what the reader is accepting. -->
            <label v-if="unaudited && actionable" class="flex cursor-pointer items-start gap-2 text-xs text-content">
                <input v-model="acknowledged" type="checkbox" class="mt-0.5 shrink-0 accent-primary-600" />
                <span>{{ t(`sandbox.discoverDetail.understandNobodyAudited`) }}</span>
            </label>

            <Notice v-if="failure" :of="failure" />
            <WaitProgress v-if="installWait" :wait="installWait" :what="installWhat" :details="run?.lines ?? []" />
            <p v-if="listing.state.action !== undefined && !canInstall" class="text-2xs text-subtle">
                {{ t(`sandbox.discoverDetail.onlySandboxOwnerInstall`) }}
            </p>

            <!-- Stuck to the foot as Capabilities' save is: the trust record above can be long on a narrow pane. -->
            <div class="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-3 px-1 py-3">
                <!-- Done: the next place to go, and the way back to browsing. Nothing to install or audit is left to offer. -->
                <template v-if="outcome">
                    <Button :label="t(`ui.action.done`)" size="small" tier="quiet" @click="emit(`back`)" />
                    <Button :label="t(`sandbox.discoverDetail.showInInstalled`)" size="small" @click="emit(`reveal`)" />
                </template>
                <!-- Order follows what's been earned: where the code's been read, Install leads and the read sits quiet at the
                     front; where it hasn't, the read leads instead, last, with Install a tier below it. -->
                <template v-else>
                    <Button
                        v-if="auditable && !auditLeads"
                        class="mr-auto"
                        :label="t(`sandbox.discoverDetail.readCodeFirst`)"
                        size="small"
                        tier="quiet"
                        @click="emit(`audit`)"
                    >
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                    <Button
                        v-if="revealable"
                        :label="t(`sandbox.discoverDetail.showInInstalled`)"
                        size="small"
                        :tier="revealLeads ? `accent` : `quiet`"
                        @click="emit(`reveal`)"
                    />
                    <Button
                        v-if="actionable"
                        :label="actionLabel"
                        size="small"
                        :loading="installing"
                        :disabled="unaudited && !acknowledged"
                        :tier="auditLeads ? `boring` : `accent`"
                        @click="emit(`install`)"
                    />
                    <Button v-if="auditLeads" :label="t(`sandbox.discoverDetail.myAgentReadCode`)" size="small" @click="emit(`audit`)">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </template>
            </div>
        </div>

        <template #aside>
            <DiscoverTrust :listing="listing" />
        </template>
    </CatalogDetail>
</template>
