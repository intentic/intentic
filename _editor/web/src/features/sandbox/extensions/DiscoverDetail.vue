<script setup lang="ts">
import { githubRepoOf } from "@intentic/registry";
import { Button, type ButtonTier, formatCount, Notice, type NoticeModel, Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic/ui";
import { computed, ref } from "vue";
import { type DiscoverListing, type InstallOutcome, splitListingName } from "../../../models/sandbox/discoverListing";
import DiscoverTrust from "./detail/DiscoverTrust.vue";
import ProfileLayout, { type ProfileStat } from "./detail/ProfileLayout.vue";
import { trustChecksOf, trustScoreOf } from "./detail/trustChecks";
import { INSTALLS } from "./installsInFlight";
import { operationAt, useOperationProgress } from "../../../workbench/operations/operations";
import ProgressMeter from "../../../components/progress/ProgressMeter.vue";
import { useT } from "@intentic/ui/i18n";
import type { AccessReason } from "../../../client/sandbox/access/accessReason";
import AccessNote from "../../../components/access/AccessNote.vue";

// One listing, read before it's run, opened where the Browse grid stood. Its card says what it is and answers "is it
// safe?" at a glance (how many of the guarantees hold, whether a human read it), with the install beside the name. Below,
// the guarantees themselves, what was checked apart from what nothing covers, and where the code lives. The owner's own
// agent read sits on the line it answers (no human review), leading where nobody has vouched for the code. An unaudited
// commit installs only after the owner ticks that they know nobody checked it. Once an install from here finishes, the
// page becomes its receipt rather than leaving the reader: what came of it, and the way to where it now lives.

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
const shortRef = computed(() => ref40.value?.slice(0, 7));

// Offered exactly when there's a commit to read; everything else on the page renders regardless of installability.
const auditable = computed(() => ref40.value !== undefined && listing.state.kind !== `blocked`);
// Installing is a maintainer's, as the daemon holds it.
const MAINTAINERS: AccessReason = { kind: `tier`, floor: `maintainer` };
const actionable = computed(() => listing.state.action !== undefined && canInstall && outcome === undefined);
// The read leads where nobody has vouched for the code and there is something to install after it; with nothing to
// install it is a tool like any other, and where a human has read the code, an option.
const readLeads = computed(() => auditable.value && !verified.value && actionable.value);
const readTier = computed<ButtonTier | undefined>(() => {
    if (!auditable.value || outcome !== undefined) {
        return undefined;
    }
    if (readLeads.value) {
        return `accent`;
    }
    return verified.value ? `quiet` : `boring`;
});

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
const revealLeads = computed(() => !actionable.value && !readLeads.value);
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
const installWait = useOperationProgress(run);
const installWhat = computed(() =>
    listing.state.kind === `update` ? t(`sandbox.discoverDetail.updatingWhat`) : t(`sandbox.discoverDetail.installingWhat`),
);

const actionLabel = computed(() => {
    if (!unaudited.value) {
        return listing.state.action;
    }
    return listing.state.kind === `update` ? t(`sandbox.discoverDetail.updateAnyway`) : t(`sandbox.discoverDetail.installAnyway`);
});

// Where the code lives, linked at the exact commit: a branch link could show code that isn't what would be installed.
const repo = computed(() => githubRepoOf(listing.entry.install));
const sourceHref = computed(() => {
    const url = listing.entry.install?.url;
    if (url === undefined) {
        return undefined;
    }
    return repo.value !== undefined && ref40.value !== undefined ? `https://github.com/${repo.value}/tree/${ref40.value}` : url.replace(/\.git$/, ``);
});
const homepageHost = computed(() => {
    const homepage = listing.entry.homepage;
    return homepage === undefined || !URL.canParse(homepage) ? undefined : new URL(homepage).host;
});

// The questions a reader opens a listing with, answered before anything else is read; each lands on its card.
const score = computed(() => trustScoreOf(trustChecksOf(listing)));
const version = computed(() => {
    const listed = listing.entry.version;
    return listed === undefined ? undefined : /^\d/.test(listed) ? `v${listed}` : listed;
});
const stats = computed<ProfileStat[]>(() => [
    {
        id: `trust`,
        icon: `shield`,
        value: `${score.value.passed} / ${score.value.total}`,
        label: t(`sandbox.discoverDetail.checksHold`),
        tone: score.value.passed === score.value.total ? `success` : `warning`,
        meter: score.value,
        target: `listing-trust`,
    },
    {
        id: `human`,
        icon: `user`,
        value: verified.value ? t(`sandbox.discoverDetail.reviewed`) : t(`sandbox.discoverDetail.notReviewed`),
        label: t(`sandbox.discoverDetail.humanReview`),
        tone: verified.value ? `success` : `warning`,
        target: `listing-trust`,
    },
    ...(listing.entry.stars === undefined
        ? []
        : [
              {
                  id: `stars`,
                  icon: `star`,
                  value: formatCount(listing.entry.stars),
                  label: t(`sandbox.discoverDetail.stars`, { count: listing.entry.stars }, listing.entry.stars),
              } satisfies ProfileStat,
          ]),
    ...(version.value === undefined
        ? []
        : [{ id: `version`, value: version.value, label: shortRef.value ?? ``, mono: true, target: `listing-source` } satisfies ProfileStat]),
]);
</script>

<template>
    <ProfileLayout
        :back="t(`ui.action.browse`)"
        :name="name.title"
        :prefix="name.publisher || undefined"
        :description="listing.entry.description"
        :art="listing.entry.art"
        :logo="listing.entry.logo"
        :icon="listing.entry.icon"
        :idle="listing.state.kind === `blocked` || listing.state.kind === `unavailable`"
        :stats="stats"
        @back="emit(`back`)"
    >
        <template v-if="badge" #badge>
            <StatusBadge size="xs" :dot="true" :variant="badge.variant" :label="badge.label" />
        </template>

        <template #actions>
            <!-- Done: the next place to go, and the way back to browsing. Nothing to install or read is left to offer. -->
            <template v-if="outcome">
                <Button :label="t(`ui.action.done`)" size="small" tier="quiet" @click="emit(`back`)" />
                <Button tier="accent" :label="t(`sandbox.discoverDetail.showInInstalled`)" size="small" @click="emit(`reveal`)" />
            </template>
            <template v-else>
                <Button
                    v-if="revealable"
                    :label="t(`sandbox.discoverDetail.showInInstalled`)"
                    size="small"
                    :tier="revealLeads ? `accent` : `quiet`"
                    @click="emit(`reveal`)"
                />
                <!-- A tier below the read wherever the read leads: nobody has vouched for this code yet. -->
                <Button
                    v-if="actionable"
                    :label="actionLabel"
                    size="small"
                    :loading="installing"
                    :disabled="unaudited && !acknowledged"
                    :tier="readLeads ? `boring` : `accent`"
                    @click="emit(`install`)"
                />
            </template>
        </template>

        <!-- What the install waits on, beside it: the explicit yes an unaudited commit needs, its progress, or why there is
             no install to press. -->
        <template v-if="(unaudited && actionable) || installWait || (listing.state.action !== undefined && !canInstall)" #hero>
            <div class="flex flex-col gap-2.5">
                <label v-if="unaudited && actionable" class="flex cursor-pointer items-start gap-2 text-xs text-content">
                    <input v-model="acknowledged" type="checkbox" class="mt-0.5 shrink-0 accent-primary-600" />
                    <span>{{ t(`sandbox.discoverDetail.understandNobodyAudited`) }}</span>
                </label>
                <ProgressMeter v-if="installWait" :progress="installWait" :what="installWhat" :details="run?.lines ?? []" />
                <AccessNote
                    v-if="listing.state.action !== undefined && !canInstall"
                    :reason="MAINTAINERS"
                    :place="t(`sandbox.sandboxNav.extensions`)"
                />
            </div>
        </template>

        <template #alerts>
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
            <Notice v-if="outcome === undefined && listing.state.kind === `update`" tone="info">
                {{ t(`sandbox.discoverDetail.updateFromTo`, { installed: listing.state.installedRef?.slice(0, 7) ?? ``, listed: shortRef ?? `` }) }}
            </Notice>
            <Notice v-if="failure" :of="failure" />
        </template>

        <DiscoverTrust :listing="listing" :read-tier="readTier" @audit="emit(`audit`)" />

        <template v-if="sourceHref || listing.entry.homepage" #aside>
            <RowGroup id="listing-source" :label="t(`sandbox.words.source`)">
                <Row v-if="sourceHref" :icon="repo === undefined ? `link` : `github`" :href="sourceHref">
                    <template #title>
                        <span class="block truncate font-mono text-xs">{{ repo ?? listing.entry.install?.url }}</span>
                    </template>
                    <template v-if="shortRef" #description>
                        <span class="block truncate font-mono">{{ shortRef }}</span>
                    </template>
                </Row>
                <Row v-if="listing.entry.install?.path" icon="folder" :description="t(`sandbox.discoverDetail.folderInRepository`)">
                    <template #title>
                        <span class="block truncate font-mono text-xs">{{ listing.entry.install.path }}</span>
                    </template>
                </Row>
                <Row
                    v-if="listing.entry.homepage"
                    icon="globe"
                    :href="listing.entry.homepage"
                    :title="t(`sandbox.discoverDetail.homepage`)"
                    :description="homepageHost"
                />
            </RowGroup>
        </template>
    </ProfileLayout>
</template>
