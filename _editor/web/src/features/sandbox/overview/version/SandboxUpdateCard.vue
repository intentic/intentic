<script setup lang="ts">
import { Button, Code, commandLang, CopyButton, type IconName, Notice, type NoticeModel, RowGroup, RowNote, StatusBadge, ui, useOsPreference } from "@intentic/ui";
import { useAsyncAction, useNow } from "@intentic/ui/async";
import { computed, ref, watchEffect } from "vue";
import DevRebuild from "../../environment/rebuild/DevRebuild.vue";
import HostRecreate from "../../../capabilities/connect/hosts/HostRecreate.vue";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandbox } from "../../client/useSandbox";
import { useRole } from "../../secrets/useRole";
import { expectRestart, type RestartQuiet } from "../../live/sandboxRestart";
import HostedRollbackDialog from "./HostedRollbackDialog.vue";
import UpdateDownloadProgress from "./UpdateDownloadProgress.vue";
import UpdateRollbackPanel from "./UpdateRollbackPanel.vue";
import UpdateWhatsNew from "./UpdateWhatsNew.vue";
import { useBackgroundDownload } from "./useBackgroundDownload";
import { type DownloadState, downloadPercent, downloadPollMs, downloadStep, downloading } from "./updateDownload";
import { updateCardPlan } from "./updateOutcome";
import { useSandboxVersion } from "./useSandboxVersion";
import { UPDATE_ACTION_ANCHOR } from "./updateAnchor";
import { apiClient } from "../../../../lib/useApi";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

// Update prompt on the sandbox hub. Updates run on the host, not the sandbox (no host Docker socket; see
// HostRecreate); a server-managed sandbox updates on its next deploy instead. Also shown with no update when there is
// something to say about the version that runs (what the machine last did about it, a release withdrawn after it
// shipped, a release skipped) or a way back to offer. The download is the machine's to do by itself, which the card
// only starts sooner and follows (updateDownload.ts), so once it is in, what the card offers is a half-minute restart.
// Which of its actions apply is decided in one place (updateOutcome.ts).
//
// AN UPDATE ON OFFER IS GOOD NEWS, AND IS DRAWN AS SOME. It used to be a wall: two full terminal walkthroughs (one of
// them for the secondary "download first"), the same cost sentence twice, three paragraphs of reassurance, the release
// notes as one run of large text, and the developer notes in a red box under a heading that called the whole update a
// danger. Now the offer is its own card, in reading order: what you get (the version, and how much is in it), the one
// gold button that takes it (or, while the update downloads in the background, how far it has got), what it costs and
// keeps as three short facts, then what is new. Everything a reader might need but most never do (the command for a
// machine this page cannot reach, what developers must change, the way back) is one line that opens.

const t = useT();

// The card's own re-read of `system.info`, set below from the download it follows: often while one runs, never when
// nothing on the card can change by itself.
const poll = ref<number | false>(false);
const {
    installed,
    latest,
    updateAvailable,
    updateNotes,
    moreUpdateNotes,
    breakingNotes,
    updateStaged,
    stagedBehind,
    stagedPlan,
    preparing,
    info,
    serverManaged,
    slug,
    skipServed,
    skipVersion,
    localImage,
} = useSandboxVersion(poll);
const { cmdOs } = useOsPreference();

// A hosted sandbox has no host to run a command on: its restart replaces the machine's image via the platform,
// keeping any environment overlay, and its rollback is the platform's too, offered once it kept an image to go back to.
const { active } = useSandbox();
const hosted = computed(() => (active.value?.hosted ? active.value.id : undefined));
// Both are the platform's, and it restarts or rolls back a machine it runs for the sandbox's owner alone
// (sandbox.routes.ts `ownedHostedMachine`): a maintainer pressing either was answered "sandbox not found". They are told
// whose press it is instead. A sandbox on somebody's own machine updates through that machine, which a maintainer reaches.
const { isOwner } = useRole();
const { busy: restarting, notice: restartNotice, run: runRestart } = useAsyncAction();
const hubWork = useHubWork();
// What the sandbox going quiet means, for every surface that isn't this card.
const RESTART_QUIET = computed((): RestartQuiet => ({
    title: t(`sandbox.sandboxUpdateCard.restartingOntoNewImage`),
    detail: t(`sandbox.sandboxUpdateCard.updateAppliedReplacesSandboxs`),
}));

const restartHosted = (): Promise<void> =>
    runRestart(
        () =>
            // The row keeps the mark through the half minute the sandbox is down, which is also the half minute
            // this page spends reconnecting.
            hubWork.track(t(`sandbox.sandboxUpdateCard.restartingSandbox`), async () => {
                const sandbox = hosted.value;
                if (sandbox === undefined) {
                    return;
                }
                // Armed before the ask: the platform can take the sandbox down before this promise settles, and
                // nothing here is told when. A refused ask ends it; otherwise the sandbox's own return does.
                const settled = expectRestart({
                    sandbox,
                    id: `update`,
                    what: t(`sandbox.sandboxUpdateCard.restartingSandbox`),
                    quiet: RESTART_QUIET.value,
                    untilAnswered: true,
                });
                try {
                    await apiClient.sandbox.hostedRestart({ sandboxId: sandbox });
                } catch (error) {
                    settled();
                    throw error;
                }
            }),
        t(`sandbox.sandboxUpdateCard.couldntRestart`),
    );

// Offered on every OS: recreate.ps1 takes -Rollback exactly as recreate.sh takes --rollback, and HostRecreate prints
// whichever the reader's OS spells.
const rollbackTo = computed(() => info.value?.previousImage);
// Full image id is noise at this distance; only the digest tail is shown, inside the expanded section.
const rollbackDigest = computed(() => rollbackTo.value?.split(`:`).pop());
const channel = computed(() => info.value?.channel);
// The machine said the version before its last swap is still parked and ready: a way back of its own, and the one
// thing on this card that stops being true with time. The clock runs only while it holds, read by the minute.
const parkedReady = computed(() => {
    const until = info.value?.lastUpdate?.keepUntil;
    return until !== undefined && until > Date.now();
});
const clock = useNow(parkedReady);
const minute = computed(() => Math.floor(clock.value / 60_000));
// Whether there is a way back from here at all: the platform's word for a hosted sandbox; for one on the owner's own,
// the image the last swap replaced or the version it parked, and a machine to run the rollback on.
const canRollBack = computed(() =>
    hosted.value === undefined
        ? (rollbackTo.value !== undefined || parkedReady.value) && slug.value !== undefined && !serverManaged.value
        : active.value?.hosted?.canRollBack === true && isOwner.value,
);
const plan = computed(() =>
    updateCardPlan({
        info: info.value,
        hosted: hosted.value !== undefined,
        canRollBack: canRollBack.value,
        skipServed: skipServed.value,
        now: parkedReady.value ? minute.value * 60_000 : Date.now(),
    }),
);

// Going back is an escape hatch, not a suggestion: it sits behind a quiet "Having trouble?" the owner has to go
// looking for, and nothing on the card names it until they open that. Next to "Updated from … to …" a Roll back
// button reads as advice to take it. Only a withdrawn release says it up front (`plan.rollbackWhy`), since there the
// publisher itself says to leave it.
const rollbackOpen = ref(false);
const toggleRollback = (): void => {
    rollbackOpen.value = !rollbackOpen.value;
};
// The hosted lane's question, asked by the platform rather than a machine.
const hostedRollingBack = ref(false);
const openRollback = (): void => {
    if (hosted.value !== undefined) {
        hostedRollingBack.value = true;
        return;
    }
    rollbackOpen.value = true;
};
// The sentence the way back opens with, when the owner went looking for it rather than a withdrawn release sending them.
const rollbackLead = computed(() =>
    plan.value.rollbackWhy ? undefined : [t(`sandbox.sandboxUpdateCard.troubleLead`), plan.value.news?.ready].filter(Boolean).join(` `),
);

// The owner's "not this one", and taking it back.
const { notice: skipNotice, run: runSkip } = useAsyncAction();
const skip = (version: string | null): Promise<void> =>
    runSkip(
        () => skipVersion(version),
        version === null ? t(`sandbox.sandboxUpdateCard.couldntShowAgain`) : t(`sandbox.sandboxUpdateCard.couldntSkip`),
    );

const withdrawnNotice = computed<NoticeModel | undefined>(() => {
    const said = plan.value.withdrawn;
    if (said === undefined) {
        return undefined;
    }
    const notice: NoticeModel = { tone: `warning`, title: said };
    return plan.value.rollbackWhy === `withdrawn` ? { ...notice, action: { label: t(`capabilities.hostRecreate.rollBackVerb`), run: openRollback } } : notice;
});

// What the machine last did. Its one action: skipping a version it gave up on (Try again is the update button
// itself, relabelled). An update that worked gets none: the way back stays behind "Having trouble?".
const newsAction = computed<NoticeModel[`action`]>(() => {
    const skippable = plan.value.skippable;
    return skippable === undefined ? undefined : { label: t(`sandbox.sandboxUpdateCard.skipThisVersion`), run: () => void skip(skippable) };
});
const newsNotice = computed<NoticeModel | undefined>(() => {
    const news = plan.value.news;
    if (news === undefined) {
        return undefined;
    }
    const said: NoticeModel = news.reason === undefined ? { tone: news.tone, title: news.text } : { tone: news.tone, title: news.text, detail: news.reason };
    const action = newsAction.value;
    return action === undefined ? said : { ...said, action };
});

// Recreating interrupts any turn in flight; resume-after-restart is off by default, so it costs the run.
const { fleet } = useAgents();
const midTurn = computed(() => fleet.value.filter(turnInFlight).length);

// The files the downloaded build converts on its first boot, read off its own pre-flight; empty when it converts none.
const convertedFiles = computed(() => stagedPlan.value?.steps ?? []);

// The downloaded build's pre-flight refuses this sandbox's files, so the swap would stop before touching anything:
// the update is not offered, and the refusal says why.
const planRefused = computed(() => updateAvailable.value && stagedPlan.value?.ok === false && localImage.value === undefined);

// The update is actually on offer from this card right now: the offer's own card, rather than the quiet group.
const offering = computed(() => updateAvailable.value && localImage.value === undefined && !planRefused.value);
// The previous version stays parked for a day only where `ic` does the swap: not on a hosted machine, not under a deploy.
const throughIc = computed(() => hosted.value === undefined && !serverManaged.value);
const retryLabel = computed(() => (plan.value.retry ? t(`sandbox.sandboxUpdateCard.tryAgain`) : undefined));

// How much is in it: every note in the gap, including the ones the daemon held back for the changelog.
const improvements = computed(() => updateNotes.value.length + moreUpdateNotes.value);

// WHAT TAKING IT COSTS AND KEEPS, as three facts short enough to read at a glance beside the button; the sentence each
// one stands for is on hover. Nothing here promises the machine goes back by itself.
interface Fact {
    readonly icon: IconName;
    readonly label: string;
    readonly tip: string;
}
const facts = computed((): Fact[] => {
    const downtimeTip = hosted.value
        ? t(`sandbox.sandboxUpdateCard.restartToUpdatePlatform`)
        : updateStaged.value
          ? t(`capabilities.hostRecreate.costRestartOnlyShort`)
          : t(`capabilities.hostRecreate.costBuildThenRestartShort`);
    return [
        // A deploy decides its own restart, so what it costs is not this card's to say.
        ...(serverManaged.value ? [] : [{ icon: `clock` as const, label: t(`sandbox.sandboxUpdateCard.factDowntime`), tip: downtimeTip }]),
        { icon: `shield`, label: t(`sandbox.sandboxUpdateCard.factFilesStay`), tip: t(`sandbox.sandboxUpdateCard.filesStay`) },
        ...(throughIc.value ? [{ icon: `undo` as const, label: t(`sandbox.sandboxUpdateCard.factUndo`), tip: t(`sandbox.sandboxUpdateCard.previousStaysReady`) }] : []),
    ];
});

// THE DOWNLOAD IS NOT A BUTTON. The machine that runs this sandbox downloads its next update by itself, and the card
// asks it to start now rather than within the next few hours (useBackgroundDownload). While it runs, its progress stands
// where the buttons do; once it is in, the gold button is a half-minute restart. Only a sandbox on its owner's own
// machine downloads that way: the platform restarts a hosted one onto its image, and a deploy moves a managed one.
const downloadsHere = computed(() => offering.value && hosted.value === undefined && !serverManaged.value && slug.value !== undefined);
const { starting } = useBackgroundDownload(() =>
    downloadsHere.value && !updateStaged.value && preparing.value === undefined && slug.value !== undefined && latest.value !== undefined
        ? { slug: slug.value, version: latest.value }
        : undefined,
);
const download = computed(
    (): DownloadState => ({ offered: downloadsHere.value, staged: updateStaged.value, preparing: preparing.value, starting: starting.value }),
);
const isDownloading = computed(() => downloading(download.value));
watchEffect(() => {
    poll.value = downloadPollMs(download.value);
});

// The quiet group's heading, for everything that is not an offer.
const quietHeading = computed(() => {
    // A checkout-built sandbox has no update on offer here at all: what it runs comes from a working tree, and the
    // published release below is named as what it would be traded for.
    if (localImage.value !== undefined) {
        return t(`sandbox.sandboxUpdateCard.builtFromCheckout`);
    }
    return planRefused.value ? t(`sandbox.sandboxUpdateCard.updateHeldBack`) : t(`sandbox.sandboxUpdateCard.sandboxImage`);
});

// Whether the checkout rebuild is drawing a run (progress, outcome) rather than only its button.
const rebuildFollowing = ref(false);
// "Having trouble?" joins the checkout rebuild's row when nothing would sit between them at the group's foot.
const troubleBesideRebuild = computed(
    () => canRollBack.value && !plan.value.rollbackWhy && localImage.value !== undefined && !serverManaged.value && !updateAvailable.value,
);
// The foot's own "Having trouble?": wherever the way back is offered and nothing else already opens it.
const troubleAtFoot = computed(() => canRollBack.value && !plan.value.rollbackWhy && !troubleBesideRebuild.value);
// The way back, open: only while there is one, however it was opened.
const rollbackShown = computed(() => canRollBack.value && rollbackOpen.value);
// The developer notes, the stored-file conversions and the way back: the offer's fine print, below what is new.
const finePrint = computed(
    () => breakingNotes.value.length > 0 || convertedFiles.value.length > 0 || stagedPlan.value?.downgrade === true || troubleAtFoot.value || rollbackShown.value,
);
</script>

<template>
    <div v-if="plan.visible">
        <!-- THE OFFER. Its own card, lit from one corner with a gold hairline along its top: the one piece of good news
             on this page, and the reading order is the order of the decision. -->
        <section v-if="offering" class="ui-card relative isolate flex flex-col overflow-hidden p-0" :aria-label="t(`sandbox.sandboxUpdateCard.updateAvailable`)">
            <div aria-hidden="true" class="pointer-events-none absolute -right-24 -top-36 -z-10 h-80 w-80 rounded-full bg-primary-500/15 blur-3xl" />
            <div aria-hidden="true" class="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-primary-500/60 to-transparent" />

            <div class="flex flex-col gap-5 p-5 sm:p-6">
                <!-- What there is to know about the version that runs, before what there is to take. -->
                <Notice v-if="withdrawnNotice" :of="withdrawnNotice" />
                <div v-if="newsNotice" class="flex flex-col gap-1.5">
                    <Notice :of="newsNotice" />
                    <!-- A path on the machine that runs the sandbox, for whoever is sitting at it. -->
                    <p v-if="plan.news?.log" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                        <span class="shrink-0">{{ t(`sandbox.sandboxUpdateCard.fullLogOnMachine`) }}</span>
                        <span class="min-w-0 truncate font-mono">{{ plan.news.log }}</span>
                        <CopyButton :text="plan.news.log" />
                    </p>
                </div>
                <Notice v-if="skipNotice" :of="skipNotice" />

                <!-- WHAT YOU GET: the version, where it takes you from, and how much is in it. -->
                <header class="flex items-start gap-3.5">
                    <span
                        class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-500/10 text-base text-primary-500 ring-1 ring-inset ring-primary-500/25"
                        aria-hidden="true"
                    >
                        <Icon name="sparkles" />
                    </span>
                    <div class="flex min-w-0 flex-col gap-1">
                        <p
                            class="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider"
                            :class="updateStaged ? `text-success` : `text-link`"
                        >
                            <Icon v-if="updateStaged" name="check-circle" aria-hidden="true" />
                            {{
                                updateStaged
                                    ? t(`sandbox.sandboxUpdateCard.updateReady`)
                                    : isDownloading
                                      ? t(`sandbox.sandboxUpdateCard.updateDownloading`)
                                      : t(`sandbox.sandboxUpdateCard.updateAvailable`)
                            }}
                        </p>
                        <h2 class="text-xl font-semibold leading-tight tracking-tight text-content">{{ t(`sandbox.sandboxUpdateCard.offerTitle`, { version: latest }) }}</h2>
                        <p class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                            <span class="inline-flex items-center gap-1.5 font-mono text-2xs">
                                <span class="rounded bg-content/5 px-1.5 py-0.5 text-subtle">{{ installed ?? `?` }}</span>
                                <Icon name="arrow-right" class="text-subtle" aria-hidden="true" />
                                <span class="rounded bg-primary-500/10 px-1.5 py-0.5 font-medium text-link">{{ latest }}</span>
                            </span>
                            <span v-if="improvements > 0">{{ t(`sandbox.sandboxUpdateCard.improvementCount`, { count: improvements }, improvements) }}</span>
                        </p>
                    </div>
                </header>

                <!-- THE STEP: the button (or the download it waits on), then what it costs and keeps. The switcher's update
                     row points at this block by id and focuses the first button in it, which is the gold one. -->
                <div :id="UPDATE_ACTION_ANCHOR" class="flex flex-col gap-3.5">
                    <p v-if="serverManaged" class="text-xs text-muted">
                        {{ t(`sandbox.sandboxUpdateCard.sandboxUpdatesOnNext`) }} <span class="font-mono text-content">intentic deploy apply</span>
                        {{ t(`sandbox.sandboxUpdateCard.againstHost`) }}
                    </p>
                    <template v-else-if="hosted">
                        <!-- Own block so the column's stretch doesn't draw the button at full width. -->
                        <div v-if="isOwner">
                            <Button :label="t(`sandbox.sandboxUpdateCard.restartUpdate`)" class="ui-button-loud ui-button-gilded" :loading="restarting" @click="restartHosted">
                                <template #icon><Icon name="arrow-circle-up" /></template>
                            </Button>
                        </div>
                        <p v-else class="text-xs text-muted">{{ t(`sandbox.sandboxUpdateCard.ownerRestartsHosted`) }}</p>
                        <Notice v-if="restartNotice" :of="restartNotice" />
                    </template>
                    <!-- Downloading in the background: nothing to press until it is in, so its progress stands in the
                         buttons' place, and the card turns to the restart by itself once it is. -->
                    <UpdateDownloadProgress v-else-if="isDownloading" :step="downloadStep(preparing)" :percent="downloadPercent(preparing)" :version="latest" />
                    <!-- Downloaded already, the gold button is the restart; otherwise it downloads, builds and restarts. -->
                    <HostRecreate v-else-if="slug" :slug="slug" action="Update" :ready="updateStaged" gilded bare keeps-said :label="retryLabel" />

                    <ul class="flex flex-wrap gap-x-5 gap-y-1.5">
                        <li v-for="fact in facts" :key="fact.icon" v-tooltip.top="fact.tip" class="flex items-center gap-1.5 text-2xs text-muted">
                            <Icon :name="fact.icon" class="shrink-0 text-subtle" aria-hidden="true" />{{ fact.label }}
                            <!-- The sentence behind the fact, for a reader who never hovers. -->
                            <span class="sr-only">{{ fact.tip }}</span>
                        </li>
                    </ul>

                    <!-- Only the restart costs a turn, and only a press starts one: said beside the button, never under a
                         download that interrupts nothing. -->
                    <p v-if="midTurn > 0 && !isDownloading" class="flex gap-1.5 text-2xs text-warning">
                        <Icon name="exclamation-triangle" class="mt-px shrink-0" aria-hidden="true" />
                        <span>
                            {{ t(`sandbox.sandboxUpdateCard.midTurnRestart`, { count: midTurn }, midTurn) }}
                            {{ t(`sandbox.sandboxUpdateCard.waitFleetToSettle`) }}
                        </span>
                    </p>
                    <!-- A staged update a newer release overtook; still worth saying, since applying now hands over the older image. -->
                    <p v-if="stagedBehind" class="text-2xs text-muted">
                        {{ t(`sandbox.sandboxUpdateCard.alreadyDownloadedHereReleased`, { stagedBehind, latest }) }}
                    </p>
                </div>
            </div>

            <!-- WHAT IS NEW, for whoever weighs it: under the button, never in the way of it. -->
            <UpdateWhatsNew
                v-if="updateNotes.length > 0"
                :notes="updateNotes"
                :more="moreUpdateNotes"
                class="border-t border-line-subtle px-5 py-5 sm:px-6"
            />

            <!-- THE FINE PRINT: each a line that opens. The developer notes gate nothing and are for whoever builds on
                 the sandbox's API or config, so they are named, counted and folded, not painted as a danger. -->
            <div v-if="finePrint" class="flex flex-col gap-3 border-t border-line-subtle px-5 py-4 sm:px-6">
                <details v-if="convertedFiles.length > 0" class="group">
                    <summary :class="ui.textAction(`w-full list-none [&::-webkit-details-marker]:hidden`)">
                        <Icon name="file-edit" class="shrink-0 text-subtle" aria-hidden="true" />
                        <span class="flex-1">{{ t(`sandbox.sandboxUpdateCard.updateConvertsStoredFiles`, { count: convertedFiles.length }, convertedFiles.length) }}</span>
                        <Icon name="chevron-right" class="shrink-0 text-subtle transition-transform group-open:rotate-90" aria-hidden="true" />
                    </summary>
                    <div class="flex flex-col gap-1.5 pb-1 pl-6 pt-1">
                        <ul class="flex flex-col gap-1">
                            <li v-for="step in convertedFiles" :key="`${step.document}:${step.change}`" class="text-2xs text-muted">
                                <span class="font-mono text-content">{{ step.document }}</span>: {{ step.change }}
                            </li>
                        </ul>
                        <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.convertedFilesKeptAside`) }}</p>
                    </div>
                </details>
                <p v-if="stagedPlan?.downgrade" class="text-2xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.newerVersionConvertedTheseFiles`) }}
                </p>
                <details v-if="breakingNotes.length > 0" class="group">
                    <summary :class="ui.textAction(`w-full list-none [&::-webkit-details-marker]:hidden`)">
                        <Icon name="code" class="shrink-0 text-warning" aria-hidden="true" />
                        <span class="flex-1">{{ t(`sandbox.sandboxUpdateCard.developerChanges`, { count: breakingNotes.length }, breakingNotes.length) }}</span>
                        <Icon name="chevron-right" class="shrink-0 text-subtle transition-transform group-open:rotate-90" aria-hidden="true" />
                    </summary>
                    <div class="flex flex-col gap-2.5 pb-1 pl-6 pt-1">
                        <p class="text-2xs text-muted">
                            {{ t(`sandbox.sandboxUpdateCard.developerChangesLead`) }}
                            <a href="https://intentic.dev/docs/updates/" target="_blank" rel="noopener" class="text-link hover:underline">{{
                                t(`sandbox.sandboxUpdateCard.whatUpdatesNeverBreak`)
                            }}</a
                            >.
                        </p>
                        <ul class="flex flex-col gap-1.5">
                            <li v-for="note in breakingNotes" :key="note" class="flex gap-2 text-2xs text-content">
                                <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning/70" aria-hidden="true" />
                                <span>{{ note }}</span>
                            </li>
                        </ul>
                    </div>
                </details>
                <!-- The way back, tucked away: there for whoever comes looking and never pitched to whoever doesn't. -->
                <button v-if="troubleAtFoot" type="button" :class="ui.textAction(`self-end text-2xs text-subtle`)" :aria-expanded="rollbackOpen" @click="toggleRollback">
                    {{ t(`sandbox.sandboxUpdateCard.havingTrouble`) }}
                </button>
                <UpdateRollbackPanel
                    v-if="rollbackShown"
                    :lead="rollbackLead"
                    :mid-turn="midTurn"
                    :digest="rollbackDigest"
                    :hosted="hosted !== undefined"
                    :slug="slug"
                    @hosted-rollback="hostedRollingBack = true"
                />
            </div>
        </section>

        <!-- NO OFFER: the version that runs, and what there is to know or do about it, as a quiet group like the rest of the page. -->
        <RowGroup v-else :label="quietHeading">
            <template #actions>
                <div class="flex flex-wrap items-center justify-end gap-2">
                    <StatusBadge v-if="plan.withdrawn" variant="warning" :label="t(`sandbox.sandboxUpdateCard.withdrawnBadge`)" dot />
                    <!-- Neutral on a checkout-built sandbox: the two versions still differ and the badge still says so, but an
                         amber "take this" on a card telling you not to would be the card arguing with itself. -->
                    <StatusBadge v-if="updateAvailable" :variant="localImage ? `neutral` : `warning`" :label="`${installed ?? '?'} → ${latest}`" dot />
                    <StatusBadge v-else-if="plan.skipped" variant="neutral" :label="t(`sandbox.sandboxUpdateCard.skippedBadge`)" />
                    <StatusBadge v-else-if="channel === `stable` && !plan.withdrawn" variant="success" :label="t(`shared.upToDate`)" dot />
                    <StatusBadge v-else-if="channel && !plan.withdrawn" variant="neutral" :label="channel" />
                </div>
            </template>

            <RowNote variant="block">
                <div class="flex flex-col gap-4">
                    <!-- What there is to know about the version that runs, before what there is to do. -->
                    <Notice v-if="withdrawnNotice" :of="withdrawnNotice" />
                    <div v-if="newsNotice" class="flex flex-col gap-1.5">
                        <Notice :of="newsNotice" />
                        <p v-if="plan.news?.log" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                            <span class="shrink-0">{{ t(`sandbox.sandboxUpdateCard.fullLogOnMachine`) }}</span>
                            <span class="min-w-0 truncate font-mono">{{ plan.news.log }}</span>
                            <CopyButton :text="plan.news.log" />
                        </p>
                    </div>
                    <p v-if="plan.skipped" class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        <span>{{ t(`sandbox.sandboxUpdateCard.skippedLine`, { version: plan.skipped }) }}</span>
                        <button type="button" :class="ui.textAction()" @click="skip(null)">{{ t(`sandbox.sandboxUpdateCard.showItAgain`) }}</button>
                    </p>
                    <Notice v-if="skipNotice" :of="skipNotice" />

                    <div v-if="slug && !serverManaged && (localImage || planRefused)" :id="UPDATE_ACTION_ANCHOR" class="flex flex-col gap-2">
                        <!-- A sandbox on a checkout-built base is not updated from the registry: a pull would REPLACE its image with a published build, not refresh it. -->
                        <template v-if="localImage">
                            <!-- One row with "Having trouble?" rather than two while it is only a button; once a rebuild draws its
                                 progress, the link drops to the foot so the bar keeps the full width and the timer its own edge. -->
                            <div :class="rebuildFollowing ? `flex flex-col gap-3` : `flex flex-wrap items-start justify-between gap-2`">
                                <DevRebuild
                                    v-model:following="rebuildFollowing"
                                    class="min-w-0 flex-1"
                                    :slug="slug"
                                    :base="localImage.base"
                                    :root="localImage.root"
                                />
                                <button
                                    v-if="troubleBesideRebuild"
                                    type="button"
                                    :class="ui.textAction(`text-2xs text-subtle ${rebuildFollowing ? `self-end` : ``}`)"
                                    :aria-expanded="rollbackOpen"
                                    @click="toggleRollback"
                                >
                                    {{ t(`sandbox.sandboxUpdateCard.havingTrouble`) }}
                                </button>
                            </div>
                            <!-- A command, not a button: taking the published image throws away what a checkout built, which is a thing to mean rather than to click. -->
                            <template v-if="updateAvailable">
                                <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.publishedNewerThanWhat`, { latest }) }}</p>
                                <Code
                                    :code="`ic sandbox update ${slug} --force`"
                                    :lang="commandLang(cmdOs)"
                                    :label="t(`sandbox.sandboxUpdateCard.takePublishedImageInstead`)"
                                    :wrap="true"
                                />
                            </template>
                        </template>
                        <!-- Held back by its own pre-flight: not offered, and skipping it is the one thing left to decide. -->
                        <template v-else>
                            <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.notOfferedUntilFixed`) }}</p>
                            <button v-if="skipServed && latest" type="button" :class="ui.textAction()" @click="skip(latest)">
                                {{ t(`sandbox.sandboxUpdateCard.skipThisVersion`) }}
                            </button>
                        </template>
                    </div>

                    <!-- The downloaded build's pre-flight over this sandbox's own files: a refusal is said before anyone takes it. -->
                    <div v-if="planRefused" class="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
                        <p class="text-xs font-medium text-danger">{{ t(`sandbox.sandboxUpdateCard.updateWouldStopBeforeTouching`) }}</p>
                        <ul class="flex flex-col gap-1">
                            <li v-for="failure in stagedPlan?.failures ?? []" :key="failure.document" class="text-2xs text-content">
                                <span class="font-mono">{{ failure.document }}</span>: {{ failure.detail }}
                            </li>
                        </ul>
                    </div>

                    <!-- The way back, tucked away behind a quiet "Having trouble?" at the foot; a withdrawn release opens the
                         same panel from its notice instead. When "Having trouble?" already sits beside the checkout rebuild,
                         skip this shell while closed — an empty flex child still earns a gap-4 above the block's foot. -->
                    <div v-if="troubleAtFoot || rollbackShown" class="flex flex-col gap-2">
                        <button
                            v-if="troubleAtFoot"
                            type="button"
                            :class="ui.textAction(`self-end text-2xs text-subtle`)"
                            :aria-expanded="rollbackOpen"
                            @click="toggleRollback"
                        >
                            {{ t(`sandbox.sandboxUpdateCard.havingTrouble`) }}
                        </button>
                        <UpdateRollbackPanel
                            v-if="rollbackShown"
                            :lead="rollbackLead"
                            :mid-turn="midTurn"
                            :digest="rollbackDigest"
                            :hosted="hosted !== undefined"
                            :slug="slug"
                            @hosted-rollback="hostedRollingBack = true"
                        />
                    </div>
                </div>
            </RowNote>
        </RowGroup>

        <HostedRollbackDialog :sandbox="hostedRollingBack ? active : undefined" @close="hostedRollingBack = false" />
    </div>
</template>
