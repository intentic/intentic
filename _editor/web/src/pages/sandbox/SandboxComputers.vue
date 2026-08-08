<script setup lang="ts">
import type { Computer, MachineSandbox, MachineSandboxOp } from "@intentic/sandbox-contract";
import { Card, cmp, MachineDetail, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import BridgeTokensCard from "./BridgeTokensCard.vue";
import { computerDetails, osLabel, osTitle, syncAgentBehind } from "./computerFacts";
import DesktopSyncCard from "./DesktopSyncCard.vue";
import MachineRunLog from "./MachineRunLog.vue";
import { manageMachineSandbox, reportStale, useComputers } from "../../composables/sandbox/useComputers";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";
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

/* The release this sandbox knows about — the SAME value behind its own update badge, because one release stamps
 * the daemon, the image and both machine agents alike. It rides the shared /info query, so putting agent
 * staleness on these rows costs no request: the answer is already in the cache this tab's chip reads.
 *
 * Undefined on a sandbox that has not reached the registry (or is a dev build and never will), which is what
 * makes the version parts render exactly as they did before rather than guessing. */
const { latest } = useSandboxVersion();
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

const sorted = computed(() => computers.value.toSorted((a, b) => a.label.localeCompare(b.label)));

/* The management buttons, shown only where they can work: the machine is reachable as a connected computer right
 * now. The daemon adds no judgement and neither does this — a click travels to the machine, and the machine's own
 * refusal (the "Manage sandboxes on this computer" switch is off, say) is shown under the row verbatim. */
const manageable = (computer: Computer): boolean => computer.hostId !== undefined && computer.online === true;

const rowKey = (computer: Computer, box: MachineSandbox): string => `${computer.key}:${box.slug}`;
const busy = ref<string | undefined>();
const actionError = ref<{ key: string; message: string } | undefined>();
const actionDone = ref<{ key: string; message: string } | undefined>();
// The running operation's output, keyed by row so leaving a log on screen while reading another row's is fine.
const runLines = ref<Record<string, string[]>>({});

/* WHICH ROW IS THE SANDBOX YOU ARE LOOKING AT. The container's slug on its machine is the leading label of the
 * daemon's own hostname — the same derivation the sandbox switcher uses for its teardown command, and the same
 * one the setup CLI applies when it names the container.
 *
 * It matters because this view can stop and delete the very sandbox serving it. That is a legitimate thing to
 * want and a terrible thing to do by accident, so the row says so and the confirmation names it. */
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));
const isSelf = (computer: Computer, box: MachineSandbox): boolean => computer.hostId !== undefined && box.slug === ownSlug.value;

// The ops that end this browser's own connection when they are aimed at the sandbox serving it. Everything but
// `start`, which is the one that can only ever help.
const SEVERING = new Set<MachineSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`]);

const CONFIRM: Partial<Record<MachineSandboxOp, (name: string) => string>> = {
    remove: (name) =>
        `Remove ${name}?\n\nThis deletes it and everything in it — its files and its history — from that computer. This cannot be undone.`,
    update: (name) => `Update ${name}?\n\nIt restarts onto the newest image and is unavailable for a few minutes. Its files are kept.`,
    rollback: (name) => `Roll ${name} back?\n\nIt returns to the image it ran before its last update. Its files are kept.`,
};

const act = async (computer: Computer, box: MachineSandbox, op: MachineSandboxOp): Promise<void> => {
    if (computer.hostId === undefined || busy.value !== undefined) {
        return;
    }
    const name = box.name ?? box.slug;
    const asked = CONFIRM[op]?.(name);
    // The self-warning rides the confirmation rather than replacing it: "this deletes everything" and "this also
    // closes the page you are on" are two different things to know, and the second never cancels the first.
    const severing = isSelf(computer, box) && SEVERING.has(op) ? `\n\nThis is the sandbox you are using right now — this page will lose it.` : ``;
    if ((asked !== undefined || severing !== ``) && !globalThis.confirm(`${asked ?? `${name}: ${op}?`}${severing}`)) {
        return;
    }
    const key = rowKey(computer, box);
    busy.value = `${key}:${op}`;
    actionError.value = undefined;
    actionDone.value = undefined;
    runLines.value = { ...runLines.value, [key]: [] };
    try {
        const message = await manageMachineSandbox(computer.hostId, box.slug, op, {
            onLine: (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
        });
        actionDone.value = { key, message };
    } catch (failure) {
        actionError.value = { key, message: failure instanceof Error ? failure.message : String(failure) };
    } finally {
        busy.value = undefined;
        // Always, including after a failure: a flow that stopped halfway still changed the machine, and the row
        // must describe what is there now rather than what was there when it started.
        refetch();
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
                    <!-- WHICH COMPUTER THIS IS. Beside the name rather than down in the detail line because it is
                         the fact that tells two rows apart at a glance, and the one the rows were missing: three
                         machines used to differ only by the word somebody typed when they added them. -->
                    <span v-if="osLabel(computer)" class="truncate text-2xs text-muted" :title="osTitle(computer)">{{ osLabel(computer) }}</span>
                    <StatusBadge :variant="tone(computer)" size="xs" :dot="true" :label="label(computer)" class="ml-auto" />
                </div>

                <!-- How this sandbox reaches it, what it runs on, and which agents are on it — one wrapping line,
                     because each part is a fact somebody occasionally needs and none of them is worth a row. -->
                <p v-if="computerDetails(computer, latest).length > 0" class="text-2xs text-subtle">
                    {{ computerDetails(computer, latest).join(` · `) }}
                </p>

                <!-- The remedy, next to the machine it is about and only while it is true. An agent that has
                     fallen behind is not an error — sync keeps working — so this is a quiet line rather than a
                     warning, and it names the one command that fixes it instead of sending anyone to the browser
                     for a pairing token. -->
                <p v-if="syncAgentBehind(computer, latest)" class="text-2xs text-subtle">
                    Run <span class="font-mono text-content">intentic-sync upgrade</span> on that computer to update its sync agent.
                </p>

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
                    <div v-for="box in computer.report.sandboxes" :key="box.container" class="flex flex-col gap-1">
                        <div class="flex flex-wrap items-center gap-x-2 text-2xs">
                            <StatusBadge :variant="box.running ? `success` : `neutral`" size="xs" :label="box.running ? `running` : `stopped`" />
                            <span class="truncate font-mono text-content">{{ box.name ?? box.slug }}</span>
                            <!-- The one row on this page that can close the page. Said before the buttons rather
                                 than in the confirmation alone, so it is known before anything is clicked. -->
                            <span v-if="isSelf(computer, box)" class="text-subtle">· the one you're using</span>
                            <!-- Absent tunnel and stopped tunnel are different facts; only the second is a warning. -->
                            <span v-if="box.tunnelRunning === false" class="text-warning">· tunnel off</span>
                            <!-- WHICH IMAGE it is on — the fact Update is about, and the only way to see that one
                                 sandbox on this machine is running something older than its neighbour. -->
                            <span class="truncate font-mono text-subtle" :title="box.image">{{ box.image }}</span>
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
                                <!-- Update is offered whether or not it is running: a stopped sandbox is exactly
                                     the one somebody wants on a newer image before starting it again. -->
                                <Button
                                    label="Update"
                                    size="small"
                                    :text="true"
                                    :loading="busy === `${rowKey(computer, box)}:update`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `update`)"
                                />
                                <Button
                                    label="Remove"
                                    size="small"
                                    severity="danger"
                                    :text="true"
                                    :loading="busy === `${rowKey(computer, box)}:remove`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `remove`)"
                                />
                            </span>
                        </div>
                        <!-- The machine's own output while it works, and only while this row is the one working:
                             an operation that finished has said everything it had to say in its result line. -->
                        <MachineRunLog
                            v-if="busy?.startsWith(`${rowKey(computer, box)}:`)"
                            :lines="runLines[rowKey(computer, box)] ?? []"
                            :running="true"
                        />
                        <p v-if="actionError?.key === rowKey(computer, box)" :class="cmp.alertDanger(`text-2xs`)">{{ actionError.message }}</p>
                        <p v-else-if="actionDone?.key === rowKey(computer, box)" class="text-2xs text-muted">{{ actionDone.message }}</p>
                    </div>
                </div>
            </div>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />
    </div>
</template>
