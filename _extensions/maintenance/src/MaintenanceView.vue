<script setup lang="ts">
import { type ChoreVerdict, repoLabel } from "@intentic/sandbox-contract/chores";
import { Button, Icon, Page, PageHeader, RowGroup, Segmented } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledge } from "./attention";
import ChoreRow from "./ChoreRow.vue";
import { host } from "./host";
import MaintenanceSkeleton from "./MaintenanceSkeleton.vue";
import { conversationIdOf } from "./runs";
import ProbeStrip from "./ProbeStrip.vue";
import { useChores } from "./useChores";
import { useRuns } from "./useRuns";

/* MAINTENANCE — the chore book, against this workspace, with the evidence attached.
 *
 * Laid out as one list per repository rather than one list of everything, because a chore is decided per repo and
 * acted on per repo: "update dependencies" in two repositories is two different pieces of work with two different
 * answers, and a merged list would have to re-state the repo on every row anyway.
 *
 * The filter defaults to what needs attention, and that is the only thing hidden by default — "Everything" is one
 * click away and shows the clear and unmeasured rows too. Both halves matter. A surface that only ever shows
 * problems cannot be used to check that there are none, and the reason a chore is CLEAR (measured yesterday,
 * nothing found) is exactly the reassurance someone opens this page for.
 *
 * Opening the page acknowledges what is on it (attention.ts): the rail's badge means "evidence you have not seen",
 * so seeing it is what clears it. Nothing is marked done, nothing is dismissed — the chores stay exactly as due as
 * they were. */

const api = host();
const { byRepo, error, isPending, refresh, refreshProbe, snooze } = useChores();
const { latestByChore, start, promote } = useRuns();

type Filter = "attention" | "all";
const filter = ref<Filter>(`attention`);
const expanded = ref<string>();
const busy = ref(false);
const notice = ref<string>();

const rowKey = (verdict: ChoreVerdict): string => `${verdict.repo}|${verdict.chore.id}`;

// A month. Long enough to mean "not this cycle" and short enough that nobody has to remember they said it —
// a snooze that outlives the reason for it is indistinguishable from the chore being wrong.
const SNOOZE_MS = 30 * 86_400_000;

/* A chore that does not APPLY here is not a row under any filter — there is no Dockerfile to slim, no pipeline to
 * tighten, no documentation to re-read, and listing it as "clear" would claim we checked something that does not
 * exist. It is not hidden either: the footer below names every one of them and why, so "why is there no Docker
 * chore in this repo?" has an answer that is one glance away rather than a support question. */
const shown = (verdicts: readonly ChoreVerdict[]): ChoreVerdict[] => {
    const applicable = verdicts.filter((verdict) => verdict.state !== `not-applicable`);
    return filter.value === `all` ? applicable : applicable.filter((verdict) => verdict.state === `due` || verdict.state === `snoozed`);
};

const groups = computed(() =>
    byRepo.value
        .map((group) => ({
            ...group,
            rows: shown(group.verdicts),
            due: group.verdicts.filter((verdict) => verdict.state === `due`).length,
            // Only under "Everything": someone scanning for what needs attention is not asking what was ruled out,
            // and the footer would be noise on every repository in the list.
            inapplicable: filter.value === `all` ? group.verdicts.filter((verdict) => verdict.state === `not-applicable`) : [],
        }))
        // A repository with nothing to show under the current filter drops out entirely rather than rendering an
        // empty heading — under "Everything" that can never happen, so the empty state below stays meaningful.
        .filter((group) => group.rows.length > 0),
);

const totalDue = computed(() => byRepo.value.reduce((sum, group) => sum + group.verdicts.filter((verdict) => verdict.state === `due`).length, 0));

const allVerdicts = computed(() => byRepo.value.flatMap((group) => group.verdicts));

/* Acknowledge whatever is currently due, whenever it changes while this page is open. `immediate` because the
 * common case is arriving here BECAUSE the tile was lit — the first render is the moment the evidence was seen.
 * Idempotent by digest, so the repeated firing this watcher does costs one comparison and no write. */
watch(
    allVerdicts,
    (verdicts) => {
        void acknowledge(verdicts);
    },
    { immediate: true },
);

// Finished runs become ledger rows here, on the same data the page already holds — see useRuns.promote for why
// the agent writes a file and the browser does the recording.
const ledgerRunIds = computed(() => new Set(allVerdicts.value.flatMap((verdict) => (verdict.lastRun === undefined ? [] : [verdict.lastRun.runId]))));
watch(
    [latestByChore, ledgerRunIds],
    () => {
        void promote(ledgerRunIds.value);
    },
    { immediate: true },
);

// One place for every action's failure, because they all fail the same way (the daemon said no) and each of them
// is a single click whose only feedback is that something happened.
const attempt = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    busy.value = true;
    notice.value = undefined;
    try {
        await action();
    } catch (failure) {
        notice.value = `Could not ${what}: ${failure instanceof Error ? failure.message : String(failure)}`;
    } finally {
        busy.value = false;
    }
};

const onStart = (verdict: ChoreVerdict): void => {
    void attempt(`start that turn`, async () => {
        // Straight into the conversation it just started: the turn IS the work, and a page that spawns an agent
        // and then keeps you on the page has hidden the only thing you now care about. The chore row stays
        // behind, and will show the run when you come back.
        api.chat.openSession(conversationIdOf(await start(verdict)));
    });
};
</script>

<template>
    <Page width="wide">
        <PageHeader title="Maintenance" description="What this workspace is owed, what measured it, and what has already been done about it.">
            <template #actions>
                <Segmented
                    v-model="filter"
                    size="xs"
                    :options="[
                        { label: `Needs attention`, value: `attention`, badge: totalDue, title: `Chores that are due or snoozed` },
                        { label: `Everything`, value: `all`, title: `Every chore in the book, including the clear and the unmeasured` },
                    ]"
                />
                <Button size="small" severity="secondary" text :disabled="busy" title="Re-read the evidence" @click="void refresh()">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </template>
        </PageHeader>

        <p v-if="notice" class="mb-3 text-xs text-warning">{{ notice }}</p>
        <p v-if="error" class="mb-3 text-xs text-warning">{{ error }}</p>

        <!-- Nothing has come back yet — including the window where the sandbox handshake still gates the fetch.
             Show the book's shape rather than a sentence, so the page that arrives is the page you were already
             looking at. -->
        <MaintenanceSkeleton v-if="isPending" />

        <!-- The empty state under "Needs attention" is the one this design most wants to be reachable, so it says
             what was checked rather than congratulating anyone. -->
        <div v-else-if="groups.length === 0" class="flex flex-col items-start gap-2 py-10">
            <p class="text-sm text-content">Nothing needs attention.</p>
            <p class="max-w-[60ch] text-xs text-subtle">
                Every chore in the book is either clear or waiting on a measurement. Switch to Everything to see what was checked, when, and what
                could not be measured at all.
            </p>
            <Button size="small" severity="secondary" text label="Show everything" @click="filter = `all`" />
        </div>

        <div v-else class="flex flex-col gap-4">
            <RowGroup
                v-for="group in groups"
                :key="group.repo"
                :label="repoLabel(group.repo)"
                :count="group.due === 0 ? undefined : group.due"
                caption="chores are decided per repository — the evidence is this repository's"
            >
                <ProbeStrip
                    :probes="group.probes"
                    :busy="busy"
                    @refresh="(id) => void attempt(`refresh that measurement`, () => refreshProbe(group.repo, id))"
                />
                <ChoreRow
                    v-for="verdict in group.rows"
                    :key="rowKey(verdict)"
                    :verdict="verdict"
                    :run="latestByChore.get(rowKey(verdict))"
                    :expanded="expanded === rowKey(verdict)"
                    :busy="busy"
                    @toggle="expanded = expanded === rowKey(verdict) ? undefined : rowKey(verdict)"
                    @start="onStart(verdict)"
                    @snooze="void attempt(`snooze that chore`, () => snooze(verdict, Date.now() + SNOOZE_MS))"
                    @unsnooze="void attempt(`un-snooze that chore`, () => snooze(verdict, 0))"
                    @open="(conversationId) => api.chat.openSession(conversationId)"
                />
                <!-- What was considered and ruled out. Dim, last, and one line per chore: this is the answer to a
                     question nobody asks until they ask it, and it must not compete with the rows above it. -->
                <p v-if="group.inapplicable.length > 0" class="border-t border-line/60 px-4 py-2 text-2xs text-subtle">
                    <span class="text-content">Not applicable here —</span>
                    <span v-for="(verdict, index) in group.inapplicable" :key="verdict.chore.id">
                        {{ index === 0 ? `` : `; ` }}{{ verdict.chore.title.toLowerCase() }} ({{ verdict.headline }})</span
                    >.
                </p>
            </RowGroup>
        </div>
    </Page>
</template>
