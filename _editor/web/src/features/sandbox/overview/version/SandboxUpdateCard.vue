<script setup lang="ts">
import { Button, Code, commandLang, CopyButton, Notice, type NoticeModel, RowGroup, RowNote, StatusBadge, ui, useOsPreference } from "@intentic/ui";
import { useAsyncAction, useNow } from "@intentic/ui/async";
import { computed, ref } from "vue";
import DevRebuild from "../../environment/rebuild/DevRebuild.vue";
import HostRecreate from "../../../capabilities/connect/hosts/HostRecreate.vue";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandbox } from "../../client/useSandbox";
import { expectRestart, type RestartQuiet } from "../../live/sandboxRestart";
import HostedRollbackDialog from "./HostedRollbackDialog.vue";
import { updateCardPlan } from "./updateOutcome";
import { useSandboxVersion } from "./useSandboxVersion";
import { apiClient } from "../../../../lib/useApi";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

// Update prompt on the sandbox hub. Updates run on the host, not the sandbox (no host Docker socket; see
// HostRecreate); a server-managed sandbox updates on its next deploy instead. Also shown with no update when there is
// something to say about the version that runs (what the machine last did about it, a release withdrawn after it
// shipped, a release skipped) or a way back to offer, and splits download from apply so it can offer a bounded restart
// once staged. Which of its actions apply is decided in one place (updateOutcome.ts).

const t = useT();

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
    info,
    serverManaged,
    slug,
    skipServed,
    skipVersion,
    localImage,
} = useSandboxVersion();
const { cmdOs } = useOsPreference();

// A hosted sandbox has no host to run a command on: its restart replaces the machine's image via the platform,
// keeping any environment overlay, and its rollback is the platform's too, offered once it kept an image to go back to.
const { active } = useSandbox();
const hosted = computed(() => (active.value?.hosted ? active.value.id : undefined));
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
            hubWork.track(`Restarting this sandbox`, async () => {
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
        `Could not restart the sandbox.`,
    );

// A breaking update gets a danger badge and hides the update command behind one explicit click; a routine update
// keeps its one-step flow, and rollback is never gated. Acknowledgment isn't persisted, so a reload re-asks.
const breaking = computed(() => updateAvailable.value && breakingNotes.value.length > 0);
const acknowledged = ref(false);

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
        : active.value?.hosted?.canRollBack === true,
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

// Rollback is a recovery link in small text, not a status row, so it doesn't out-shout the all-clear state; a
// withdrawn release or a fresh update's ready predecessor says it up front instead (`plan.rollbackWhy`).
const rollbackOpen = ref(false);
// Named so the whole `<button>` fits one line; a wrapped line renders its underline through spaces.
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

// What the machine last did. Its one action: going back while the previous version is still parked, or skipping a
// version it gave up on (Try again is the update button itself, relabelled).
const newsAction = computed<NoticeModel[`action`]>(() => {
    const skippable = plan.value.skippable;
    if (plan.value.news?.probation === true && plan.value.rollbackWhy === `probation`) {
        return { label: t(`capabilities.hostRecreate.rollBackVerb`), run: openRollback };
    }
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

// Neutral on a checkout-built sandbox: the two versions still differ and the badge still says so, but an amber "take
// this" on a card telling you not to would be the card arguing with itself.
// The files the downloaded build converts on its first boot, read off its own pre-flight; empty when it converts none.
const convertedFiles = computed(() => stagedPlan.value?.steps ?? []);

// The downloaded build's pre-flight refuses this sandbox's files, so the swap would stop before touching anything:
// the update is not offered, and the refusal above says why.
const planRefused = computed(() => updateAvailable.value && stagedPlan.value?.ok === false && localImage.value === undefined);

// The update is actually on offer from this card right now, which is where the reassurance under it belongs.
const offering = computed(() => updateAvailable.value && localImage.value === undefined && !planRefused.value && !(breaking.value && !acknowledged.value));
// The previous version stays parked for a day only where `ic` does the swap: not on a hosted machine, not under a deploy.
const throughIc = computed(() => hosted.value === undefined && !serverManaged.value);
const retryLabel = computed(() => (plan.value.retry ? t(`sandbox.sandboxUpdateCard.tryAgain`) : undefined));

const versionBadge = computed(() => (localImage.value !== undefined ? `neutral` : breaking.value ? `danger` : `warning`));

const updateHeading = computed(() => {
    // A checkout-built sandbox has no update on offer here at all: what it runs comes from a working tree, and the
    // published release below is named as what it would be traded for.
    if (localImage.value !== undefined) {
        return `Built from your checkout`;
    }
    if (planRefused.value) {
        return t(`sandbox.sandboxUpdateCard.updateHeldBack`);
    }
    if (breaking.value) {
        return `Update available: changes how things work`;
    }
    if (updateAvailable.value) {
        return updateStaged.value ? `Update ready to apply` : `Update available`;
    }
    return `Sandbox image`;
});
</script>

<template>
    <RowGroup v-if="plan.visible" :label="updateHeading">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <StatusBadge v-if="plan.withdrawn" variant="warning" :label="t(`sandbox.sandboxUpdateCard.withdrawnBadge`)" dot />
                <StatusBadge
                    v-if="updateAvailable && updateStaged && !breaking && !planRefused"
                    variant="success"
                    :label="t(`sandbox.sandboxUpdateCard.downloaded`)"
                    dot
                />
                <StatusBadge v-if="updateAvailable" :variant="versionBadge" :label="`${installed ?? '?'} → ${latest}`" dot />
                <StatusBadge v-else-if="plan.skipped" variant="neutral" :label="t(`sandbox.sandboxUpdateCard.skippedBadge`)" />
                <StatusBadge v-else-if="channel === `stable` && !plan.withdrawn" variant="success" :label="t(`shared.upToDate`)" dot />
                <StatusBadge v-else-if="channel && !plan.withdrawn" variant="neutral" :label="channel" />
            </div>
        </template>

        <RowNote variant="block">
            <div class="flex flex-col gap-4">
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
                <p v-if="plan.skipped" class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <span>{{ t(`sandbox.sandboxUpdateCard.skippedLine`, { version: plan.skipped }) }}</span>
                    <button type="button" :class="ui.textAction()" @click="skip(null)">{{ t(`sandbox.sandboxUpdateCard.showItAgain`) }}</button>
                </p>
                <Notice v-if="skipNotice" :of="skipNotice" />
                <!-- Going back, opened from the notice above that gave the reason for it. -->
                <div v-if="rollbackOpen && plan.rollbackWhy && !hosted && slug" class="flex flex-col gap-2">
                    <p v-if="midTurn > 0" class="text-2xs text-warning">
                        {{ t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: midTurn }, midTurn) }}
                    </p>
                    <p class="text-2xs text-subtle">
                        <template v-if="rollbackDigest"
                            >{{ t(`sandbox.sandboxUpdateCard.rollsBackTo`) }} <span class="font-mono">…{{ rollbackDigest }}</span>.
                        </template>
                        {{ t(`sandbox.sandboxUpdateCard.filesStay`) }}
                    </p>
                    <HostRecreate :slug="slug" action="Roll back" />
                </div>

                <p v-if="breaking && !localImage" class="text-xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.updateRemovesChangesThings`) }}
                    <a href="https://intentic.dev/docs/updates/" target="_blank" rel="noopener" class="underline hover:text-content">{{
                        t(`sandbox.sandboxUpdateCard.whatUpdatesNeverBreak`)
                    }}</a
                    >.
                </p>
                <p v-else-if="updateStaged && updateAvailable && !localImage && !planRefused" class="text-xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.alreadyDownloadedBuiltOn`) }}
                </p>

                <!-- Never truncated: a breaking note cut by a capped list is a break taken unwarned. -->
                <div v-if="breaking" class="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
                    <p class="text-xs font-medium text-danger">{{ t(`sandbox.sandboxUpdateCard.whatChanges`) }}</p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="note in breakingNotes" :key="note" class="flex gap-2 text-2xs text-content">
                            <span class="mt-1.5 h-0.5 w-0.5 shrink-0 rounded-full bg-danger" />
                            <span>{{ note }}</span>
                        </li>
                    </ul>
                </div>

                <!-- Shown above the button, so the reader has something to weigh an update against. -->
                <div v-if="updateAvailable && updateNotes.length > 0 && !localImage" class="flex flex-col gap-2">
                    <ul class="flex flex-col gap-2">
                        <li v-for="note in updateNotes" :key="note" class="flex gap-2.5 text-sm text-content">
                            <span class="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary-500" />
                            <span>{{ note }}</span>
                        </li>
                    </ul>
                    <!-- Tail of a long gap as a count, not more bullets, so an old sandbox doesn't bury the rest of the page. -->
                    <p v-if="moreUpdateNotes > 0" class="text-xs text-subtle">
                        {{ t(`sandbox.sandboxUpdateCard.and`) }} {{ moreUpdateNotes }} {{ t(`sandbox.sandboxUpdateCard.more`) }}
                        <a href="https://intentic.dev/changelog/" target="_blank" rel="noopener" class="underline hover:text-content">{{
                            t(`sandbox.sandboxUpdateCard.readChangelog`)
                        }}</a>
                    </p>
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
                <div v-else-if="updateAvailable && convertedFiles.length > 0 && !localImage" class="flex flex-col gap-1.5">
                    <p class="text-xs font-medium text-content">
                        {{ t(`sandbox.sandboxUpdateCard.updateConvertsStoredFiles`, { count: convertedFiles.length }, convertedFiles.length) }}
                    </p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="step in convertedFiles" :key="`${step.document}:${step.change}`" class="text-2xs text-muted">
                            <span class="font-mono">{{ step.document }}</span>: {{ step.change }}
                        </li>
                    </ul>
                    <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.convertedFilesKeptAside`) }}</p>
                </div>
                <p v-if="updateAvailable && stagedPlan?.downgrade && !localImage" class="text-2xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.newerVersionConvertedTheseFiles`) }}
                </p>

                <!-- Only the restart costs a turn, so the way out is downloading first. -->
                <p v-if="midTurn > 0 && offering" class="text-2xs text-warning">
                    {{ t(`sandbox.sandboxUpdateCard.midTurnRestart`, { count: midTurn }, midTurn) }}
                    <template v-if="!updateStaged">{{ t(`sandbox.sandboxUpdateCard.downloadCostsNothing`, { count: midTurn }, midTurn) }}</template>
                    <template v-else>{{ t(`sandbox.sandboxUpdateCard.waitFleetToSettle`) }}</template>
                </p>

                <!-- A staged update a newer release overtook; still worth saying, since applying now hands over the older image. -->
                <p v-if="updateAvailable && stagedBehind" class="text-2xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.alreadyDownloadedHereReleased`, { stagedBehind, latest, stagedBehind2: stagedBehind }) }}
                </p>

                <template v-if="serverManaged">
                    <p v-if="updateAvailable" class="text-2xs text-subtle">
                        {{ t(`sandbox.sandboxUpdateCard.sandboxUpdatesOnNext`) }} <span class="font-mono">intentic deploy apply</span>
                        {{ t(`sandbox.sandboxUpdateCard.againstHost`) }}
                    </p>
                </template>
                <template v-else-if="slug">
                    <!-- A sandbox on a checkout-built base is not updated from the registry: a pull would REPLACE its image with a published build, not refresh it. -->
                    <template v-if="localImage">
                        <DevRebuild :slug="slug" :base="localImage.base" :root="localImage.root" />
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
                    <template v-else-if="planRefused">
                        <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxUpdateCard.notOfferedUntilFixed`) }}</p>
                        <button v-if="skipServed && latest" type="button" :class="ui.textAction()" @click="skip(latest)">
                            {{ t(`sandbox.sandboxUpdateCard.skipThisVersion`) }}
                        </button>
                    </template>
                    <!-- Gate for a breaking update: the copy-paste command appears only after this explicit click. -->
                    <template v-else-if="breaking && !acknowledged">
                        <Button
                            :label="t(`sandbox.sandboxUpdateCard.iveReadWhatChanges`)"
                            size="small"
                            severity="secondary"
                            @click="acknowledged = true"
                        />
                    </template>
                    <!-- One offer when the image is already staged, two when it isn't (download-only, or download-and-restart). -->
                    <template v-else-if="updateAvailable && hosted">
                        <p class="text-xs font-medium text-content">
                            {{ t(`sandbox.sandboxUpdateCard.restartToUpdatePlatform`) }}
                        </p>
                        <!-- Own block so the column's stretch doesn't draw a small button at full width. -->
                        <div>
                            <Button :label="t(`sandbox.sandboxUpdateCard.restartUpdate`)" size="small" :loading="restarting" @click="restartHosted" />
                        </div>
                        <Notice v-if="restartNotice" :of="restartNotice" />
                    </template>
                    <template v-else-if="updateAvailable && updateStaged">
                        <p class="text-xs font-medium text-content">{{ t(`sandbox.sandboxUpdateCard.applyRestartsSandbox`) }}</p>
                        <HostRecreate :slug="slug" action="Update" ready keeps-said :label="retryLabel" />
                    </template>
                    <template v-else-if="updateAvailable">
                        <div class="flex flex-col gap-2">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <HostRecreate :slug="slug" action="Update" bare keeps-said :label="retryLabel" />
                                <HostRecreate :slug="slug" action="Download" text bare />
                            </div>
                            <p class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.costBuildThenRestartShort`) }}</p>
                        </div>
                    </template>
                </template>

                <!-- What an update keeps, beside the button that takes it: true of every install. The second line only
                     where ic does the swap, since that is what keeps the version before it parked. Nothing here
                     promises the machine goes back by itself. -->
                <div v-if="offering" class="flex flex-col gap-0.5 text-2xs text-subtle">
                    <p>{{ t(`sandbox.sandboxUpdateCard.filesStay`) }}</p>
                    <p v-if="throughIc">{{ t(`sandbox.sandboxUpdateCard.previousStaysReady`) }}</p>
                </div>

                <!-- Offered alongside an available update too, since a rollback is as likely the reason someone opened this card. -->
                <p v-if="canRollBack && !plan.rollbackWhy" class="flex flex-wrap items-baseline gap-x-1 text-2xs text-subtle">
                    <span>{{
                        updateAvailable ? t(`sandbox.sandboxUpdateCard.ratherGoBack`) : t(`sandbox.sandboxUpdateCard.somethingWrongSinceLast`)
                    }}</span>
                    <button type="button" class="underline hover:text-content" @click="hosted ? openRollback() : toggleRollback()">
                        {{ t(`sandbox.sandboxUpdateCard.rollBackToPrevious`) }}
                    </button>
                </p>
                <div v-if="canRollBack && !plan.rollbackWhy && !hosted && slug && rollbackOpen" class="flex flex-col gap-2">
                    <!-- Lives here, in the all-clear state, since it cautions about the restart a rollback causes, not an update. -->
                    <p v-if="midTurn > 0 && !updateAvailable" class="text-2xs text-warning">
                        {{ t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: midTurn }, midTurn) }}
                    </p>
                    <p class="text-2xs text-subtle">
                        <template v-if="rollbackDigest"
                            >{{ t(`sandbox.sandboxUpdateCard.rollsBackTo`) }} <span class="font-mono">…{{ rollbackDigest }}</span>.
                        </template>
                        {{ t(`sandbox.sandboxUpdateCard.filesStay`) }}
                    </p>
                    <HostRecreate :slug="slug" action="Roll back" />
                </div>
            </div>

            <HostedRollbackDialog :sandbox="hostedRollingBack ? active : undefined" @close="hostedRollingBack = false" />
        </RowNote>
    </RowGroup>
</template>
