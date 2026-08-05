<script setup lang="ts">
import type { Computer, MachineSandbox } from "@intentic/sandbox-contract";
import { Card, cmp, MachineDetail, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import BridgeTokensCard from "./BridgeTokensCard.vue";
import DesktopSyncCard from "./DesktopSyncCard.vue";
import { manageMachineSandbox, reportStale, type SandboxOp, useComputers } from "../../composables/sandbox/useComputers";
import { useNow } from "../../composables/useNow";

/* The Sandbox hub's "Computers" tab — what is on the other end of this sandbox.
 *
 * It replaces the old "Sync" tab, which was a single enrollment card, and the replacement is the point. That card
 * answered "is a machine paired" and then, for everything a person actually arrives asking — which folder is this
 * syncing into, which ports did I get on localhost, why is my dev server not there — printed the name of a
 * terminal command. A machine-level view is also the only honest shape for the facts: one laptop pairing three
 * sandboxes used to render as three partial cards on three different pages, and its ports contend across all of
 * them.
 *
 * Enabling sync is still the DesktopSyncCard below, unchanged: adding a computer is a different job from reading
 * the ones you have, and that card already does it well.
 *
 * Arriving from the Workspace "Open in local editor" shortcut (?enable=desktop-sync) still flashes that card. */

const route = useRoute();
const highlight = ref(false);
const { computers, error, refetch } = useComputers();

// One clock for the whole render, so every row's staleness is judged against the same instant rather than each
// against the moment its own computed happened to run — and the app's one clock, so it stops with this tab.
const now = useNow();
onMounted(() => {
    if (route.query[`enable`] === `desktop-sync`) {
        highlight.value = true;
        setTimeout(() => document.getElementById(`desktop-sync`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    }
});

/* Each gap is a different errand, so each gets its own sentence rather than one "unavailable". `scope-off` is the
 * only one the reader closes in a single click, so it says which switch — the same way the host agent's own
 * refusals name the control rather than reporting a broken sandbox. */
const GAP_TEXT: Record<NonNullable<Computer[`gap`]>, string> = {
    offline: `Asleep or offline — nothing to read from it right now.`,
    "scope-off": `Turn on "Run commands" in this computer's capability card to see what it is running.`,
    "no-agent": `Reachable, but it has no sync agent — so nothing here knows about its folders or ports.`,
    unreported: `Enrolled, but it hasn't reported yet. An agent from before machine reports never will — re-run its install to update it.`,
};

const tone = (computer: Computer): StatusVariant => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `neutral` : `warning`;
    }
    if (reportStale(computer, now.value) || computer.report?.watcher.running === false) {
        return `warning`;
    }
    return `success`;
};

const label = (computer: Computer): string => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `offline` : `needs attention`;
    }
    return reportStale(computer, now.value) ? `gone quiet` : `live`;
};

// How this sandbox can reach the machine at all — two independent doors, and a box may be behind both.
const reach = (computer: Computer): string =>
    [computer.syncEnrolled ? `desktop sync` : undefined, computer.hostId === undefined ? undefined : `connected computer`]
        .filter((part) => part !== undefined)
        .join(" · ");

const sorted = computed(() => computers.value.toSorted((a, b) => a.label.localeCompare(b.label)));

/* The management buttons, shown only where they can work: the machine is reachable as a connected computer right
 * now. The daemon adds no judgement and neither does this — a click travels to the machine, and the machine's own
 * refusal (the "Manage sandboxes on this computer" switch is off, say) is shown under the row verbatim. */
const manageable = (computer: Computer): boolean => computer.hostId !== undefined && computer.online === true;

const rowKey = (computer: Computer, box: MachineSandbox): string => `${computer.key}:${box.slug}`;
const busy = ref<string | undefined>();
const actionError = ref<{ key: string; message: string } | undefined>();

const act = async (computer: Computer, box: MachineSandbox, op: SandboxOp): Promise<void> => {
    if (computer.hostId === undefined || busy.value !== undefined) {
        return;
    }
    const key = rowKey(computer, box);
    busy.value = `${key}:${op}`;
    actionError.value = undefined;
    try {
        await manageMachineSandbox(computer.hostId, box.slug, op);
        refetch();
    } catch (failure) {
        actionError.value = { key, message: failure instanceof Error ? failure.message : String(failure) };
    } finally {
        busy.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup label="Computers">
            <div v-if="error" :class="cmp.alertDanger('m-4 text-2xs')">{{ error }}</div>
            <div v-else-if="sorted.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                No computer is paired with this sandbox yet. Enable desktop sync below to work on it from your own editor, or add a Linux/Windows PC
                from Capabilities to let the agent work there.
            </div>
            <div v-for="computer in sorted" :key="computer.key" class="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <div class="flex flex-wrap items-center gap-2">
                    <Icon name="desktop" class="shrink-0 text-muted" />
                    <span class="truncate text-sm font-medium text-content">{{ computer.label }}</span>
                    <span class="truncate text-2xs text-subtle">{{ reach(computer) }}</span>
                    <StatusBadge :variant="tone(computer)" size="xs" :dot="true" :label="label(computer)" class="ml-auto" />
                </div>

                <!-- The reading's own age, not its arrival's: a report is a snapshot of a computer that may since
                     have closed its lid, so it is presented as of when the machine took it. -->
                <p v-if="computer.report && reportStale(computer, now)" class="text-2xs text-warning">
                    Last heard from {{ timeAgo(computer.report.capturedAt) }} — what follows is what it looked like then.
                </p>
                <p v-if="computer.gap" class="text-2xs text-muted">{{ GAP_TEXT[computer.gap] }}</p>

                <MachineDetail
                    v-if="computer.report"
                    :pairings="computer.report.pairings"
                    :ports="computer.report.ports"
                    :watcher="computer.report.watcher"
                />

                <!-- The sandboxes running ON that machine. Only a connected computer can tell us this: the sync
                     agent never reports containers, and the sandbox cannot look for itself (its docker socket is
                     deliberately not mounted). So this section is absent rather than empty for most machines. -->
                <div v-if="computer.report && computer.report.sandboxes.length > 0" class="flex flex-col gap-1.5">
                    <span class="text-2xs font-medium text-muted">Sandboxes on this computer</span>
                    <div v-for="box in computer.report.sandboxes" :key="box.container" class="flex flex-col gap-0.5">
                        <div class="flex flex-wrap items-center gap-x-2 text-2xs">
                            <StatusBadge :variant="box.running ? `success` : `neutral`" size="xs" :label="box.running ? `running` : `stopped`" />
                            <span class="truncate font-mono text-content">{{ box.name ?? box.slug }}</span>
                            <!-- Absent tunnel and stopped tunnel are different facts; only the second is a warning. -->
                            <span v-if="box.tunnelRunning === false" class="text-warning">· tunnel off</span>
                            <span v-if="manageable(computer)" class="ml-auto flex items-center gap-1">
                                <Button
                                    v-if="!box.running"
                                    label="Start"
                                    size="small"
                                    :text="true"
                                    :loading="busy === `${rowKey(computer, box)}:start`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `start`)"
                                />
                                <template v-else>
                                    <Button
                                        label="Restart"
                                        size="small"
                                        :text="true"
                                        :loading="busy === `${rowKey(computer, box)}:restart`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, box, `restart`)"
                                    />
                                    <Button
                                        label="Stop"
                                        size="small"
                                        severity="danger"
                                        :text="true"
                                        :loading="busy === `${rowKey(computer, box)}:stop`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, box, `stop`)"
                                    />
                                </template>
                            </span>
                        </div>
                        <p v-if="actionError?.key === rowKey(computer, box)" :class="cmp.alertDanger(`text-2xs`)">{{ actionError.message }}</p>
                    </div>
                </div>
            </div>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />
    </div>
</template>
