<script setup lang="ts">
import { Button, Code, commandLang, Notice, RowGroup, RowNote, StatusBadge, useOsPreference } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, ref } from "vue";
import DevRebuild from "../environment/DevRebuild.vue";
import HostRecreate from "../../capabilities/connect/HostRecreate.vue";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { useSandbox } from "../client/useSandbox";
import { useSandboxVersion } from "./useSandboxVersion";
import { apiClient } from "../../../lib/useApi";

// Update prompt on the sandbox hub. Updates run on the host, not the sandbox (no host Docker socket; see
// HostRecreate); a server-managed sandbox updates on its next deploy instead. Also shown with no update when a
// rollback exists, and splits download from apply so it can offer a bounded restart once staged.

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
const restartHosted = (): Promise<void> =>
    runRestart(async () => {
        if (hosted.value !== undefined) {
            await apiClient.sandbox.hostedRestart({ sandboxId: hosted.value });
        }
    }, `Could not restart the sandbox.`);

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
                <StatusBadge v-if="updateAvailable && updateStaged && !breaking" variant="success" label="downloaded" dot />
                <StatusBadge v-if="updateAvailable" :variant="versionBadge" :label="`${installed ?? '?'} → ${latest}`" dot />
                <StatusBadge v-else-if="channel === `stable`" variant="success" label="up to date" dot />
                <StatusBadge v-else-if="channel" variant="neutral" :label="channel" />
            </div>
        </template>

        <RowNote variant="block">
            <div class="flex flex-col gap-4">
                <p v-if="(breaking || updateAvailable) && !localImage" class="text-xs text-muted">
                    <template v-if="breaking">
                        This update removes or changes things you may rely on: read what changes below before taking it. Your files (in /work) are
                        kept either way, and you can roll back afterwards:
                        <a href="https://intentic.dev/docs/updates/" target="_blank" rel="noopener" class="underline hover:text-content"
                            >what updates never break</a
                        >.
                    </template>
                    <!-- A bounded half-minute became sayable only once the host reported what it had already downloaded. -->
                    <template v-else-if="updateStaged">
                        It is already downloaded and built on the device that runs this sandbox. Applying it restarts your sandbox for about half a
                        minute: your files (in /work) are kept.
                    </template>
                    <template v-else>
                        A newer sandbox image has been released. Downloading it interrupts nothing: your sandbox keeps working until you apply it, and
                        your files (in /work) are kept.
                    </template>
                </p>

                <!-- Never truncated: a breaking note cut by a capped list is a break taken unwarned. -->
                <div v-if="breaking" class="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
                    <p class="text-xs font-medium text-danger">What changes</p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="note in breakingNotes" :key="note" class="flex gap-2 text-2xs text-content">
                            <span class="mt-1.5 h-0.5 w-0.5 shrink-0 rounded-full bg-danger" />
                            <span>{{ note }}</span>
                        </li>
                    </ul>
                </div>

                <!--
                    Shown above the cost and the button, so the reader has something to weigh an update against. Same text as the
                    changelog for that release; absent when there's nothing to say.
                -->
                <div v-if="updateAvailable && updateNotes.length > 0 && !localImage" class="mt-3 flex flex-col gap-1.5">
                    <p class="text-xs font-medium text-content">What's new</p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="note in updateNotes" :key="note" class="flex gap-2 text-2xs text-muted">
                            <span class="mt-1.5 h-0.5 w-0.5 shrink-0 rounded-full bg-primary-500" />
                            <span>{{ note }}</span>
                        </li>
                    </ul>
                    <!-- Tail of a long gap as a count, not more bullets, so an old sandbox doesn't bury the rest of the page. -->
                    <p v-if="moreUpdateNotes > 0" class="text-2xs text-subtle">
                        …and {{ moreUpdateNotes }} more:
                        <a href="https://intentic.dev/changelog/" target="_blank" rel="noopener" class="underline hover:text-content"
                            >read the changelog</a
                        >
                    </p>
                </div>

                <!--
                    Only the restart costs a turn, so the way out is downloading first. Shown only when an update is on offer; the
                    rollback-only warning lives with the rollback disclosure instead.
                -->
                <p v-if="midTurn > 0 && updateAvailable" class="text-2xs text-warning">
                    {{ midTurn === 1 ? `An agent is` : `${midTurn} agents are` }} mid-turn right now, restarting the sandbox interrupts
                    {{ midTurn === 1 ? `its` : `their` }} work.
                    <template v-if="!updateStaged">
                        Downloading it now costs {{ midTurn === 1 ? `it` : `them` }} nothing, and the restart can wait.
                    </template>
                    <template v-else>Wait for the fleet to settle, or continue if that is acceptable.</template>
                </p>

                <!-- A staged update a newer release overtook; still worth saying, since applying now hands over the older image. -->
                <p v-if="updateAvailable && stagedBehind" class="text-2xs text-muted">
                    {{ stagedBehind }} is already downloaded here, but {{ latest }} has been released since. Updating now gives you
                    {{ stagedBehind }}, or download the newer one first.
                </p>

                <template v-if="serverManaged">
                    <p class="text-2xs text-subtle">
                        This sandbox updates on the next <span class="font-mono">intentic deploy apply</span> against its host.
                    </p>
                </template>
                <template v-else-if="slug">
                    <!--
                        A sandbox on a checkout-built base is not updated from the registry: a pull would REPLACE its
                        image with a published build, not refresh it, so the rebuild that does apply is what's offered
                        and the trade is spelled out rather than made by a click.
                    -->
                    <template v-if="localImage">
                        <DevRebuild :slug="slug" :base="localImage.base" :root="localImage.root" />
                        <!-- A command, not a button: taking the published image throws away what a checkout built, which is
                             a thing to mean rather than to click. Its own block, so it stays copyable whole. -->
                        <template v-if="updateAvailable">
                            <p class="text-2xs text-subtle">
                                The published {{ latest }} is newer than what this sandbox reports, but taking it discards the image built from your
                                checkout. On the device that runs it:
                            </p>
                            <Code
                                :code="`ic sandbox update ${slug} --force`"
                                :lang="commandLang(cmdOs)"
                                label="Take the published image instead"
                                :wrap="true"
                            />
                        </template>
                    </template>
                    <!-- Gate for a breaking update: the copy-paste command appears only after this explicit click. -->
                    <template v-else-if="breaking && !acknowledged">
                        <Button label="I've read what changes: show me the update" size="small" severity="secondary" @click="acknowledged = true" />
                    </template>
                    <!--
                        One offer when the image is already staged, two when it isn't (download-only, or download-and-restart); the
                        card already lays out two blocks side by side when rollback is also offered.
                    -->
                    <template v-else-if="updateAvailable && hosted">
                        <p class="text-xs font-medium text-content">
                            Restart to update: the platform boots your sandbox onto the new image, files kept.
                        </p>
                        <!-- Own block so the column's stretch doesn't draw a small button at full width. -->
                        <div>
                            <Button label="Restart and update" size="small" :loading="restarting" @click="restartHosted" />
                        </div>
                        <Notice v-if="restartNotice" :of="restartNotice" />
                    </template>
                    <template v-else-if="updateAvailable && updateStaged">
                        <p class="text-xs font-medium text-content">Apply it: this restarts your sandbox:</p>
                        <HostRecreate :slug="slug" action="Update" ready />
                    </template>
                    <template v-else-if="updateAvailable">
                        <p class="text-xs font-medium text-content">Download it now: nothing restarts until you say so:</p>
                        <HostRecreate :slug="slug" action="Download" />
                        <p class="text-xs font-medium text-content">Or do both now, downloading and restarting in one go:</p>
                        <HostRecreate :slug="slug" action="Update" />
                    </template>
                    <!--
                        Offered alongside an available update too, since a rollback is as likely the reason someone opened this card. A
                        text link, not a row: findable if you came for it, invisible otherwise.
                    -->
                    <p v-if="rollbackTo && !hosted" class="text-2xs text-subtle">
                        <!--
                            Explicit space: Vue drops a whitespace-only text node spanning a newline, and the sentence would run into the
                            link without it.
                        -->
                        <template v-if="updateAvailable">Rather go back?&#32;</template>
                        <template v-else>Something wrong since the last update?&#32;</template>
                        <button type="button" class="underline hover:text-content" @click="toggleRollback">Roll back to the previous image</button>
                    </p>
                    <div v-if="rollbackTo && !hosted && rollbackOpen" class="flex flex-col gap-2">
                        <!-- Lives here, in the all-clear state, since it cautions about the restart a rollback causes, not an update. -->
                        <p v-if="midTurn > 0 && !updateAvailable" class="text-2xs text-warning">
                            {{ midTurn === 1 ? `An agent is` : `${midTurn} agents are` }} mid-turn right now, rolling back interrupts
                            {{ midTurn === 1 ? `its` : `their` }} work.
                        </p>
                        <p class="text-2xs text-subtle">
                            Rolls back to <span class="font-mono">…{{ rollbackDigest }}</span
                            >. Your files (in /work) are kept either way.
                        </p>
                        <HostRecreate :slug="slug" action="Roll back" />
                    </div>
                </template>
            </div>
        </RowNote>
    </RowGroup>
</template>
