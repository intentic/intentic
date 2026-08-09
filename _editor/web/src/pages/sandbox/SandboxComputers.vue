<script setup lang="ts">
import type { Computer, MachineSandbox, MachineSandboxOp } from "@intentic/sandbox-contract";
import { Card, cmp, MachineDetail, Notice, type NoticeModel, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/ui";
import { noticeFrom } from "../../composables/useAsyncAction";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import BridgeTokensCard from "./BridgeTokensCard.vue";
import { computerDoors, lastSeenNote, machineFacts, osLabel, osTitle, syncAgentBehind } from "./computerFacts";
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
// The list query's bare message, in the words of the page that asked for it.
const computersNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list your computers.`, detail: error.value },
);

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

/* The card's internal headings. Smaller and quieter than the group's own label (cmp.sectionLabel), because they
 * divide ONE computer's card rather than the page — but shaped like a heading, which the old `text-2xs
 * font-medium text-muted` was not: it was the same size and nearly the same grey as the rows it introduced, so
 * "Sandboxes on this computer" read as another line of detail rather than as the start of a section. */
const SUBHEAD = `text-2xs font-semibold uppercase tracking-wide text-subtle`;

/* And the size of the buttons in those sections. A PrimeVue button left at its own defaults is a 14px label in a
 * 38px control, which beside an 11px row is not an action on the row — it is the loudest thing on the card, four
 * times over. The app's dense lists already say this in their own markup (AgentCard, AgentsView); the row of
 * verbs here is the same tier. */
const ACTION = `px-2 py-1 text-2xs`;

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

/* THE MACHINES WORTH READING, FIRST. Sorting the list by name alone put an offline box and a stale one above the
 * laptop actually serving folders and ports — three screens of "nothing to read from it right now" before the
 * card the reader came for. State leads, name breaks ties, so the order only ever changes when a machine's state
 * does, which is a change worth noticing rather than a list that reshuffles under the cursor.
 *
 * Live before needs-attention on purpose: a machine that wants something is one quiet sentence, and its badge
 * already finds the eye, while a live one is the whole point of the page. */
const RANK: Record<string, number> = { live: 0, "needs attention": 1, "gone quiet": 2, offline: 3 };

const sorted = computed(() => computers.value.toSorted((a, b) => (RANK[label(a)] ?? 9) - (RANK[label(b)] ?? 9) || a.label.localeCompare(b.label)));

/* The management buttons, shown only where they can work: the machine is reachable as a connected computer right
 * now. The daemon adds no judgement and neither does this — a click travels to the machine, and the machine's own
 * refusal (the "Manage sandboxes on this computer" switch is off, say) is shown under the row verbatim. */
const manageable = (computer: Computer): boolean => computer.hostId !== undefined && computer.online === true;

const rowKey = (computer: Computer, box: MachineSandbox): string => `${computer.key}:${box.slug}`;
const busy = ref<string | undefined>();
const actionError = ref<{ key: string; notice: NoticeModel } | undefined>();
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
        actionError.value = { key, notice: noticeFrom(failure, `That didn't work on this computer.`) };
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
            <Notice v-if="computersNotice" :of="computersNotice" class="m-4" />
            <div v-else-if="sorted.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                No computer is paired with this sandbox yet. Enable desktop sync below to work on it from your own editor, or add a Linux/Windows PC
                from Capabilities to let the agent work there.
            </div>
            <div v-for="computer in sorted" :key="computer.key" class="flex flex-col gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
                <!-- WHO THIS IS — the name, what kind of computer it is, and whether it is here. Everything in
                     this block identifies the machine; how the sandbox talks to it is the row below, because
                     they were one grey line of six dot-separated facts and read as none. -->
                <div class="flex items-start gap-2.5">
                    <Icon name="desktop" class="mt-px shrink-0 text-base text-muted" />
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2">
                            <span class="truncate text-sm font-semibold text-content">{{ computer.label }}</span>
                            <!-- WHICH COMPUTER THIS IS. Beside the name rather than down in the detail line because
                                 it is the fact that tells two rows apart at a glance, and the one the rows were
                                 missing: three machines used to differ only by the word somebody typed when they
                                 added them. -->
                            <span v-if="osLabel(computer)" class="truncate text-xs text-muted" :title="osTitle(computer)">{{
                                osLabel(computer)
                            }}</span>
                        </div>
                        <p v-if="machineFacts(computer).length > 0" class="truncate text-2xs text-subtle">{{ machineFacts(computer).join(` · `) }}</p>
                    </div>
                    <StatusBadge :variant="tone(computer)" size="xs" :dot="true" :label="label(computer)" class="mt-0.5 shrink-0" />
                </div>

                <!-- HOW THIS SANDBOX REACHES IT — one chip per door, each carrying the version of the agent
                     behind it. A chip rather than another entry in the fact line: these two are the difference
                     between a machine that syncs your files and one the agent can run commands on, and a reader
                     scanning three computers is usually looking for exactly that.

                     A newer release rides INSIDE the chip it is about, right after the version it supersedes,
                     rather than at the end of a line the reader would have to match back up to a door. -->
                <div v-if="computerDoors(computer, latest).length > 0 || lastSeenNote(computer)" class="flex flex-wrap items-center gap-1.5">
                    <span
                        v-for="door in computerDoors(computer, latest)"
                        :key="door.name"
                        class="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-2xs text-muted"
                    >
                        <Icon :name="door.name === `desktop sync` ? `sync` : `terminal`" class="text-2xs text-subtle" />
                        {{ door.name }}
                        <span v-if="door.version" class="font-mono text-subtle">{{ door.version }}</span>
                        <span v-if="door.available" class="font-mono text-warning">{{ door.available }} available</span>
                    </span>
                    <span v-if="lastSeenNote(computer)" class="text-2xs text-subtle">{{ lastSeenNote(computer) }}</span>
                </div>

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

                <!-- WHAT IT DOES FOR YOUR SANDBOXES, under the name the rest of the product uses for it — the
                     same words as the card below that switches it on, so the two are recognisably one feature. -->
                <div v-if="computer.report" class="flex flex-col gap-1.5">
                    <span :class="SUBHEAD">Desktop sync</span>
                    <MachineDetail :pairings="computer.report.pairings" :ports="computer.report.ports" :watcher="computer.report.watcher" />
                </div>

                <!-- The sandboxes running ON that machine. Only a connected computer can tell us this: the sync
                     agent never reports containers, and the sandbox cannot look for itself (its docker socket is
                     deliberately not mounted). So this section is absent rather than empty for most machines. -->
                <div v-if="computer.report && computer.report.sandboxes.length > 0" class="flex flex-col gap-1.5">
                    <span :class="SUBHEAD">Sandboxes on this computer</span>
                    <div
                        v-for="box in computer.report.sandboxes"
                        :key="box.container"
                        class="flex flex-col gap-1.5 rounded-lg border border-line bg-content/3 px-3 py-2.5"
                    >
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                            <!-- What it is, kept together as one block, so a narrow window wraps the verbs away
                                 from the name instead of stranding a chip on a line of its own. -->
                            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                                <StatusBadge
                                    :variant="box.running ? `success` : `neutral`"
                                    :dot="true"
                                    size="xs"
                                    :label="box.running ? `running` : `stopped`"
                                />
                                <span class="truncate font-mono text-xs text-content">{{ box.name ?? box.slug }}</span>
                                <!-- The one row on this page that can close the page. Said before the buttons
                                     rather than in the confirmation alone, so it is known before anything is
                                     clicked. -->
                                <StatusBadge v-if="isSelf(computer, box)" variant="info" size="xs" label="the one you're using" />
                                <!-- Absent tunnel and stopped tunnel are different facts; only the second is a warning. -->
                                <StatusBadge v-if="box.tunnelRunning === false" variant="warning" size="xs" label="tunnel off" />
                            </div>
                            <span v-if="manageable(computer)" class="ml-auto flex items-center gap-1">
                                <Button
                                    v-if="!box.running"
                                    label="Start"
                                    size="small"
                                    :text="true"
                                    :class="ACTION"
                                    :loading="busy === `${rowKey(computer, box)}:start`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `start`)"
                                />
                                <template v-else>
                                    <Button
                                        label="Restart"
                                        size="small"
                                        :text="true"
                                        :class="ACTION"
                                        :loading="busy === `${rowKey(computer, box)}:restart`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, box, `restart`)"
                                    />
                                    <Button
                                        label="Stop"
                                        size="small"
                                        severity="danger"
                                        :text="true"
                                        :class="ACTION"
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
                                    :class="ACTION"
                                    :loading="busy === `${rowKey(computer, box)}:update`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `update`)"
                                />
                                <Button
                                    label="Remove"
                                    size="small"
                                    severity="danger"
                                    :text="true"
                                    :class="ACTION"
                                    :loading="busy === `${rowKey(computer, box)}:remove`"
                                    :disabled="busy !== undefined"
                                    @click="act(computer, box, `remove`)"
                                />
                            </span>
                        </div>
                        <!-- WHICH IMAGE it is on — the fact Update is about, and the only way to see that one
                             sandbox on this machine is running something older than its neighbour. On its own
                             line: it is the longest string in the block and the least often read, so it stops
                             pushing the name and the buttons around. -->
                        <span class="truncate font-mono text-2xs text-subtle" :title="box.image">{{ box.image }}</span>
                        <!-- The machine's own output while it works, and only while this row is the one working:
                             an operation that finished has said everything it had to say in its result line. -->
                        <MachineRunLog
                            v-if="busy?.startsWith(`${rowKey(computer, box)}:`)"
                            :lines="runLines[rowKey(computer, box)] ?? []"
                            :running="true"
                        />
                        <Notice v-if="actionError?.key === rowKey(computer, box)" :of="actionError.notice" />
                        <p v-else-if="actionDone?.key === rowKey(computer, box)" class="text-2xs text-muted">{{ actionDone.message }}</p>
                    </div>
                </div>
            </div>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />
    </div>
</template>
