<script setup lang="ts">
import { Button, Code, commandLang, Notice, RowGroup, RowNote, StatusBadge, useOsPreference } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, ref } from "vue";
import DevRebuild from "../../environment/DevRebuild.vue";
import HostRecreate from "../../../capabilities/connect/HostRecreate.vue";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandbox } from "../../client/useSandbox";
import { expectRestart, type RestartQuiet } from "../../live/sandboxRestart";
import { useSandboxVersion } from "./useSandboxVersion";
import { apiClient } from "../../../../lib/useApi";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

// Update prompt on the sandbox hub. Updates run on the host, not the sandbox (no host Docker socket; see
// HostRecreate); a server-managed sandbox updates on its next deploy instead. Also shown with no update when a
// rollback exists, and splits download from apply so it can offer a bounded restart once staged.

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
    info,
    serverManaged,
    slug,
    localImage,
} = useSandboxVersion();
const { cmdOs } = useOsPreference();

// A hosted sandbox has no host to run a command on: this restart replaces the machine's image via the platform,
// keeping any environment overlay. No rollback offered: the platform keeps no previous image.
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

// Rollback is POSIX-only (recreate.ps1 has no `-Rollback`); hidden on Windows rather than offered and failing.
const rollbackTo = computed(() => (cmdOs.value === `windows` ? undefined : info.value?.previousImage));
// Full image id is noise at this distance; only the digest tail is shown, inside the expanded section.
const rollbackDigest = computed(() => rollbackTo.value?.split(`:`).pop());
const channel = computed(() => info.value?.channel);

// Rollback is a recovery link in small text, not a status row, so it doesn't out-shout the all-clear state.
const rollbackOpen = ref(false);
// Named so the whole `<button>` fits one line; a wrapped line renders its underline through spaces.
const toggleRollback = (): void => {
    rollbackOpen.value = !rollbackOpen.value;
};

// Recreating interrupts any turn in flight; resume-after-restart is off by default, so it costs the run.
const { fleet } = useAgents();
const midTurn = computed(() => fleet.value.filter(turnInFlight).length);

// Neutral on a checkout-built sandbox: the two versions still differ and the badge still says so, but an amber "take
// this" on a card telling you not to would be the card arguing with itself.
const versionBadge = computed(() => (localImage.value !== undefined ? `neutral` : breaking.value ? `danger` : `warning`));

const updateHeading = computed(() => {
    // A checkout-built sandbox has no update on offer here at all: what it runs comes from a working tree, and the
    // published release below is named as what it would be traded for.
    if (localImage.value !== undefined) {
        return `Built from your checkout`;
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
    <RowGroup v-if="updateAvailable || rollbackTo" :label="updateHeading">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <StatusBadge
                    v-if="updateAvailable && updateStaged && !breaking"
                    variant="success"
                    :label="t(`sandbox.sandboxUpdateCard.downloaded`)"
                    dot
                />
                <StatusBadge v-if="updateAvailable" :variant="versionBadge" :label="`${installed ?? '?'} → ${latest}`" dot />
                <StatusBadge v-else-if="channel === `stable`" variant="success" :label="t(`shared.upToDate`)" dot />
                <StatusBadge v-else-if="channel" variant="neutral" :label="channel" />
            </div>
        </template>

        <RowNote variant="block">
            <div class="flex flex-col gap-4">
                <p v-if="breaking && !localImage" class="text-xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.updateRemovesChangesThings`) }}
                    <a href="https://intentic.dev/docs/updates/" target="_blank" rel="noopener" class="underline hover:text-content">{{
                        t(`sandbox.sandboxUpdateCard.whatUpdatesNeverBreak`)
                    }}</a
                    >.
                </p>
                <p v-else-if="updateStaged && updateAvailable && !localImage" class="text-xs text-muted">
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

                <!-- Only the restart costs a turn, so the way out is downloading first. -->
                <p v-if="midTurn > 0 && updateAvailable" class="text-2xs text-warning">
                    {{ t(`sandbox.sandboxUpdateCard.midTurnRestart`, { count: midTurn }, midTurn) }}
                    <template v-if="!updateStaged">{{ t(`sandbox.sandboxUpdateCard.downloadCostsNothing`, { count: midTurn }, midTurn) }}</template>
                    <template v-else>{{ t(`sandbox.sandboxUpdateCard.waitFleetToSettle`) }}</template>
                </p>

                <!-- A staged update a newer release overtook; still worth saying, since applying now hands over the older image. -->
                <p v-if="updateAvailable && stagedBehind" class="text-2xs text-muted">
                    {{ t(`sandbox.sandboxUpdateCard.alreadyDownloadedHereReleased`, { stagedBehind, latest, stagedBehind2: stagedBehind }) }}
                </p>

                <template v-if="serverManaged">
                    <p class="text-2xs text-subtle">
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
                        <HostRecreate :slug="slug" action="Update" ready />
                    </template>
                    <template v-else-if="updateAvailable">
                        <div class="flex flex-col gap-2">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <HostRecreate :slug="slug" action="Update" bare />
                                <HostRecreate :slug="slug" action="Download" text bare />
                            </div>
                            <p class="text-2xs text-subtle">{{ t(`capabilities.hostRecreate.costBuildThenRestart`) }}</p>
                        </div>
                    </template>
                    <!-- Offered alongside an available update too, since a rollback is as likely the reason someone opened this card. -->
                    <p v-if="rollbackTo && !hosted" class="flex flex-wrap items-baseline gap-x-1 text-2xs text-subtle">
                        <span>{{
                            updateAvailable ? t(`sandbox.sandboxUpdateCard.ratherGoBack`) : t(`sandbox.sandboxUpdateCard.somethingWrongSinceLast`)
                        }}</span>
                        <button type="button" class="underline hover:text-content" @click="toggleRollback">
                            {{ t(`sandbox.sandboxUpdateCard.rollBackToPrevious`) }}
                        </button>
                    </p>
                    <div v-if="rollbackTo && !hosted && rollbackOpen" class="flex flex-col gap-2">
                        <!-- Lives here, in the all-clear state, since it cautions about the restart a rollback causes, not an update. -->
                        <p v-if="midTurn > 0 && !updateAvailable" class="text-2xs text-warning">
                            {{ t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: midTurn }, midTurn) }}
                        </p>
                        <p class="text-2xs text-subtle">
                            {{ t(`sandbox.sandboxUpdateCard.rollsBackTo`) }} <span class="font-mono">…{{ rollbackDigest }}</span
                            >. Your files (in /work) are kept either way.
                        </p>
                        <HostRecreate :slug="slug" action="Roll back" />
                    </div>
                </template>
            </div>
        </RowNote>
    </RowGroup>
</template>
