<script setup lang="ts">
import type { Computer, MachineSandboxOp } from "@intentic/sandbox-contract";
import { type MachineSandboxGroup, MachineDetail, Notice, type NoticeModel, RowGroup, StatusBadge, type StatusVariant, timeAgo } from "@intentic/ui";
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
 * ONE COMPUTER, ONE ROW; ONE SANDBOX, ONE ROW INSIDE IT. The tab shipped with each machine's sandboxes printed
 * twice — folders and ports under "Desktop sync", containers and their buttons under "Sandboxes on this
 * computer" — under two different names for the same box, each in its own filled and bordered block inside the
 * page's own card. Two of everything, three surfaces deep, all of it the same grey. <MachineDetail> now joins the
 * two halves and this page hands it the containers and the verbs; what is left here is what a row says about the
 * MACHINE, which is the half that view cannot know.
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

/* THIS TAB USES THREE SIZES, as a rule rather than a habit: 14px for the one thing that names an entry (the
 * computer), 12px for everything a person READS — a path, a port, a sentence, a verb — and 11px for the labels
 * and ids that only have to be findable. It shipped with nearly all of it at 11px, paths and sentences included,
 * which is what "the sizes feel off" turns out to mean once measured: there was no scale, just one small size
 * with two exceptions.
 *
 * The smallest of the three, shaped like a heading: it divides ONE computer's entry rather than the page, so it
 * stays under the group's own label (cmp.sectionLabel) — but it has to read as a heading, which the plain
 * `text-2xs text-muted` it replaced did not. */
const SUBHEAD = `text-2xs font-semibold uppercase tracking-wide text-subtle`;

/* HOW THIS SANDBOX REACHES THE MACHINE — one tag per door, tinted rather than outlined. A border here put a
 * third rectangle inside a card that already had two, for two words; a wash of the ink says "this is a tag" with
 * no edge to add to the pile. */
const DOOR = `inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-0.5 text-2xs text-muted`;

/* And the size of the buttons on a sandbox row. A PrimeVue button left at its own defaults is a 14px label in a
 * 38px control, which beside a 12px row is not an action on the row — it is the loudest thing on the card, four
 * times over. The app's dense lists already say this in their own markup (AgentCard, AgentsView); the row of
 * verbs here is the same tier.
 *
 * They are all SECONDARY except the one that deletes. Stop and Restart were drawn in the same red as Remove, so
 * the three most alarming words on the page were also two of its most ordinary ones, and the eye went to them
 * before it went to the machine's own state. Red now means exactly one thing here. */
const ACTION = `px-2 py-1 text-xs`;

const tone = (computer: Computer): StatusVariant => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `neutral` : `warning`;
    }
    if (reportStale(computer, now.value) || computer.report?.watcher.running === false) {
        return `warning`;
    }
    return `success`;
};

/* THE BADGE'S WORD, and it now agrees with the badge's COLOUR. A machine whose sync agent has died is amber —
 * `tone` has always said so, because nothing is reaching its folders or ports — and said "live" in that amber,
 * which is the one pairing of word and colour a reader cannot act on. It is the same errand as a gap: something
 * on that computer wants attention. */
const label = (computer: Computer): string => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `offline` : `needs attention`;
    }
    if (reportStale(computer, now.value)) {
        return `gone quiet`;
    }
    return computer.report?.watcher.running === false ? `needs attention` : `live`;
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
 * now, and the row in front of us is a container rather than a pairing nothing on that machine answers for. The
 * daemon adds no judgement and neither does this — a click travels to the machine, and the machine's own refusal
 * (the "Manage sandboxes on this computer" switch is off, say) is shown under the row verbatim. */
const manageable = (computer: Computer, group: MachineSandboxGroup): boolean =>
    computer.hostId !== undefined && computer.online === true && group.sandbox !== undefined;

const rowKey = (computer: Computer, group: MachineSandboxGroup): string => `${computer.key}:${group.sandboxId}`;
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
const isSelf = (computer: Computer, group: MachineSandboxGroup): boolean =>
    computer.hostId !== undefined && group.sandbox?.slug === ownSlug.value;

// The ops that end this browser's own connection when they are aimed at the sandbox serving it. Everything but
// `start`, which is the one that can only ever help.
const SEVERING = new Set<MachineSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`]);

const CONFIRM: Partial<Record<MachineSandboxOp, (name: string) => string>> = {
    remove: (name) =>
        `Remove ${name}?\n\nThis deletes it and everything in it — its files and its history — from that computer. This cannot be undone.`,
    update: (name) => `Update ${name}?\n\nIt restarts onto the newest image and is unavailable for a few minutes. Its files are kept.`,
    rollback: (name) => `Roll ${name} back?\n\nIt returns to the image it ran before its last update. Its files are kept.`,
};

const act = async (computer: Computer, group: MachineSandboxGroup, op: MachineSandboxOp): Promise<void> => {
    if (computer.hostId === undefined || group.sandbox === undefined || busy.value !== undefined) {
        return;
    }
    const slug = group.sandbox.slug;
    const asked = CONFIRM[op]?.(group.title);
    // The self-warning rides the confirmation rather than replacing it: "this deletes everything" and "this also
    // closes the page you are on" are two different things to know, and the second never cancels the first.
    const severing =
        isSelf(computer, group) && SEVERING.has(op) ? `\n\nThis is the sandbox you are using right now — this page will lose it.` : ``;
    if ((asked !== undefined || severing !== ``) && !globalThis.confirm(`${asked ?? `${group.title}: ${op}?`}${severing}`)) {
        return;
    }
    const key = rowKey(computer, group);
    busy.value = `${key}:${op}`;
    actionError.value = undefined;
    actionDone.value = undefined;
    runLines.value = { ...runLines.value, [key]: [] };
    try {
        const message = await manageMachineSandbox(computer.hostId, slug, op, {
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
        <RowGroup label="Computers" :count="sorted.length === 0 ? undefined : sorted.length">
            <Notice v-if="computersNotice" :of="computersNotice" class="m-4" />
            <div v-else-if="sorted.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                No computer is paired with this sandbox yet. Enable desktop sync below to work on it from your own editor, or add a Linux/Windows PC
                from Capabilities to let the agent work there.
            </div>
            <!-- ONE GUTTER PER COMPUTER. The glyph sits in a column of its own and everything else — the name,
                 the facts, the machine's whole sandbox list — starts at the same x underneath it, so three
                 computers read as three entries rather than as nine indents. -->
            <div v-for="computer in sorted" :key="computer.key" class="flex items-start gap-3 border-b border-line px-4 py-4 last:border-b-0">
                <Icon name="desktop" class="mt-0.5 shrink-0 text-base text-muted" />
                <div class="flex min-w-0 flex-1 flex-col gap-3">
                    <!-- WHO THIS IS — the name, what kind of computer it is, and whether it is here. -->
                    <div class="flex min-w-0 flex-col gap-1.5">
                        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="truncate text-sm font-semibold text-content">{{ computer.label }}</span>
                            <!-- WHICH COMPUTER THIS IS. Beside the name rather than down in the detail line
                                 because it is the fact that tells two rows apart at a glance, and the one the
                                 rows were missing: three machines used to differ only by the word somebody typed
                                 when they added them. -->
                            <span v-if="osLabel(computer)" class="truncate text-xs text-muted" :title="osTitle(computer)">{{
                                osLabel(computer)
                            }}</span>
                            <StatusBadge :variant="tone(computer)" size="xs" :dot="true" :label="label(computer)" class="ml-auto shrink-0" />
                        </div>
                        <!-- WHAT IT IS AND HOW THIS SANDBOX REACHES IT, on one line. Two facts of two kinds, so
                             the doors keep a shape of their own: they are the difference between a machine that
                             syncs your files and one the agent can run commands on, and a reader scanning three
                             computers is usually looking for exactly that.
                             A newer release rides INSIDE the tag it is about, right after the version it
                             supersedes, rather than at the end of a line the reader would have to match back up
                             to a door. -->
                        <div
                            v-if="machineFacts(computer).length > 0 || computerDoors(computer, latest).length > 0 || lastSeenNote(computer)"
                            class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
                        >
                            <p v-if="machineFacts(computer).length > 0" class="min-w-0 truncate text-xs text-muted">
                                {{ machineFacts(computer).join(` · `) }}
                            </p>
                            <span v-for="door in computerDoors(computer, latest)" :key="door.name" :class="DOOR">
                                <Icon :name="door.name === `desktop sync` ? `sync` : `terminal`" class="text-2xs text-subtle" />
                                {{ door.name }}
                                <span v-if="door.version" class="font-mono text-subtle">{{ door.version }}</span>
                                <span v-if="door.available" class="font-mono text-warning">{{ door.available }} available</span>
                            </span>
                            <span v-if="lastSeenNote(computer)" class="text-xs text-subtle">{{ lastSeenNote(computer) }}</span>
                        </div>
                    </div>

                    <!-- WHAT THE ROW WANTS FROM YOU, if anything — each on its own line, in the tone it earns. -->
                    <div
                        v-if="syncAgentBehind(computer, latest) || (computer.report && reportStale(computer, now)) || computer.gap"
                        class="flex flex-col gap-1"
                    >
                        <!-- An agent that has fallen behind is not an error — sync keeps working — so this is a
                             quiet line rather than a warning, and it names the one command that fixes it instead
                             of sending anyone to the browser for a pairing token. -->
                        <p v-if="syncAgentBehind(computer, latest)" class="text-xs text-subtle">
                            Run <span class="font-mono text-content">intentic-sync upgrade</span> on that computer to update its sync agent.
                        </p>
                        <!-- The reading's own age, not its arrival's: a report is a snapshot of a computer that
                             may since have closed its lid, so it is presented as of when the machine took it. -->
                        <p v-if="computer.report && reportStale(computer, now)" class="text-xs text-warning">
                            Last heard from {{ timeAgo(computer.report.capturedAt) }} — what follows is what it looked like then.
                        </p>
                        <p v-if="computer.gap" class="text-xs text-muted">{{ GAP_TEXT[computer.gap] }}</p>
                    </div>

                    <!-- WHAT IT IS RUNNING FOR YOU: one row per sandbox, carrying its folder, its ports, its
                         image and its verbs. Only a machine that reported can say any of it. -->
                    <div v-if="computer.report" class="border-t border-line pt-3">
                        <MachineDetail
                            :pairings="computer.report.pairings"
                            :ports="computer.report.ports"
                            :sandboxes="computer.report.sandboxes"
                            :watcher="computer.report.watcher"
                        >
                            <!-- What the list is, and the state of the agent behind it, on one line — the
                                 watcher is a fact about the MACHINE rather than about any row under it. -->
                            <template #heading><span :class="SUBHEAD">Sandboxes on this computer</span></template>
                            <!-- The one row on this page that can close the page. Said beside the name rather
                                 than in the confirmation alone, so it is known before anything is clicked. -->
                            <template #badges="{ group }">
                                <StatusBadge v-if="isSelf(computer, group)" variant="info" size="xs" label="the one you're using" />
                            </template>
                            <template #actions="{ group }">
                                <template v-if="manageable(computer, group)">
                                    <Button
                                        v-if="group.sandbox?.running === false"
                                        label="Start"
                                        size="small"
                                        severity="secondary"
                                        :text="true"
                                        :class="ACTION"
                                        :loading="busy === `${rowKey(computer, group)}:start`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, group, `start`)"
                                    />
                                    <template v-else>
                                        <Button
                                            label="Restart"
                                            size="small"
                                            severity="secondary"
                                            :text="true"
                                            :class="ACTION"
                                            :loading="busy === `${rowKey(computer, group)}:restart`"
                                            :disabled="busy !== undefined"
                                            @click="act(computer, group, `restart`)"
                                        />
                                        <Button
                                            label="Stop"
                                            size="small"
                                            severity="secondary"
                                            :text="true"
                                            :class="ACTION"
                                            :loading="busy === `${rowKey(computer, group)}:stop`"
                                            :disabled="busy !== undefined"
                                            @click="act(computer, group, `stop`)"
                                        />
                                    </template>
                                    <!-- Update is offered whether or not it is running: a stopped sandbox is
                                         exactly the one somebody wants on a newer image before starting it
                                         again. -->
                                    <Button
                                        label="Update"
                                        size="small"
                                        severity="secondary"
                                        :text="true"
                                        :class="ACTION"
                                        :loading="busy === `${rowKey(computer, group)}:update`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, group, `update`)"
                                    />
                                    <Button
                                        label="Remove"
                                        size="small"
                                        severity="danger"
                                        :text="true"
                                        :class="ACTION"
                                        :loading="busy === `${rowKey(computer, group)}:remove`"
                                        :disabled="busy !== undefined"
                                        @click="act(computer, group, `remove`)"
                                    />
                                </template>
                            </template>
                            <!-- The machine's own output while it works, and only while this row is the one
                                 working: an operation that finished has said everything it had to say in its
                                 result line. -->
                            <template #footer="{ group }">
                                <MachineRunLog
                                    v-if="busy?.startsWith(`${rowKey(computer, group)}:`)"
                                    :lines="runLines[rowKey(computer, group)] ?? []"
                                    :running="true"
                                />
                                <Notice v-if="actionError?.key === rowKey(computer, group)" :of="actionError.notice" />
                                <p v-else-if="actionDone?.key === rowKey(computer, group)" class="text-xs text-muted">{{ actionDone.message }}</p>
                            </template>
                        </MachineDetail>
                    </div>
                </div>
            </div>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />
    </div>
</template>
