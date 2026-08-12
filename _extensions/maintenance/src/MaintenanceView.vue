<script setup lang="ts">
import { CHORE_KINDS, CHORES, type ChoreVerdict, repoLabel } from "@intentic/sandbox-contract/chores";
import { type AgentRunChoice, Button, cmp, PageAction, RowGroup, Segmented, SplitView } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { acknowledge } from "./attention";
import ChoreRow from "./ChoreRow.vue";
import { host } from "./host";
import MaintenanceSkeleton from "./MaintenanceSkeleton.vue";
import RepoRail from "./RepoRail.vue";
import RepoScope from "./RepoScope.vue";
import { conversationIdOf } from "./runs";
import { useChores } from "./useChores";
import { useRuns } from "./useRuns";

/* MAINTENANCE — the chore book, against this workspace, with the evidence attached.
 *
 * TWO AXES, AND THEY DO DIFFERENT JOBS. A chore is decided and acted on PER REPOSITORY — "update dependencies" in
 * two repositories is two different pieces of work with two different answers — so the repository is what the rail
 * scopes by, and one repository's chores are what the body is about. But repository is a bad way to SORT the rows
 * inside it: it was one flat column of thirteen, where "16 advisories · carrying" and "not surveyed in 90 days"
 * were the same object with a different badge colour, and the reader had to re-derive from each row how alarmed to
 * be. Grouped by kind (CHORE_KINDS), the same rows read as "one risk you are carrying, two things accruing, one
 * drift, two reading assignments" — and the page finally says out loud that only one of the six is urgent.
 *
 * That grouping is also the page keeping its own promise. Every row here shows its working so you can disagree
 * with it; the ordering was the one editorial claim the page made, it lived in a comment in the chore book, and it
 * was thrown away at render — a claim nobody could see, let alone argue with.
 *
 * The rail NARROWS, it does not select a document: every row is a real chore under "All repositories" as much as
 * under one of them. So the page keeps <SplitView>'s default `collapse` behaviour on a phone, and the rail sits
 * above the list rather than covering it. It disappears entirely when there is one repository or when the host
 * pinned one (the Workspace tree's per-repo panel) — an index over a single thing is a column of chrome.
 *
 * The filter defaults to what needs attention, and that is the only thing hidden by default — "Everything" is one
 * click away and shows the clear and unmeasured rows too. Both halves matter. A surface that only ever shows
 * problems cannot be used to check that there are none, and the reason a chore is CLEAR (measured yesterday,
 * nothing found) is exactly the reassurance someone opens this page for.
 *
 * Opening the page acknowledges what is on it (attention.ts): the rail's badge means "evidence you have not seen",
 * so seeing it is what clears it. Nothing is marked done, nothing is dismissed — the chores stay exactly as due as
 * they were. */

// Bound by the host for a `directory` activation; absent for the rail's workspace-wide tile, which picks its own.
const { repo: pinned } = defineProps<{ repo?: string }>();

const api = host();
const { byRepo, error, isPending, refresh, refreshProbe, snooze } = useChores();
const { latestByChore, start, promote } = useRuns();

type Filter = "attention" | "all";
const filter = ref<Filter>(`attention`);
const expanded = ref<string>();
const busy = ref(false);
const notice = ref<string>();

/* WHICH REPOSITORY IS IN VIEW LIVES IN THE URL, so "what does intentic owe" is a link somebody can be sent.
 * Derived from the query rather than mirrored into a ref: one direction of flow, and Back/Forward work for free.
 * Absent means every repository, which is why it is `undefined` rather than a sentinel — the tidy URL is the one
 * you get by default. The filter is NOT in the URL: it is a posture, not a place. */
const query = computed(() => api.route.query());
const repo = computed<string | undefined>({
    get: () => pinned ?? query.value[`repo`],
    set: (value) => api.route.setQuery({ repo: value }),
});

const rowKey = (verdict: ChoreVerdict): string => `${verdict.repo}|${verdict.chore.id}`;

// A month. Long enough to mean "not this cycle" and short enough that nobody has to remember they said it —
// a snooze that outlives the reason for it is indistinguishable from the chore being wrong.
const SNOOZE_MS = 30 * 86_400_000;

// What the rail lists. The count is what is DUE — thirteen chores is the same number everywhere and says nothing —
// and `carrying` rides along as the row's colour, since one live advisory and one dependency drift are not the
// same morning's work (RepoRail).
const repos = computed(() =>
    byRepo.value.map(({ repo: at, verdicts }) => ({
        repo: at,
        due: verdicts.filter((verdict) => verdict.state === `due`).length,
        carrying: verdicts.filter((verdict) => verdict.state === `due` && verdict.severity === `warning`).length,
    })),
);

/* The rail exists when the view is the thing choosing the scope, and not when the host already fixed it — which is
 * the whole difference between the two surfaces. Deliberately NOT "when there is more than one repository": that
 * is unknown until the report lands, so the column would appear a moment after the page did and shove the list
 * 17rem sideways under the reader's eyes, to reach a case the rail surface cannot be in anyway (the report always
 * carries the workspace root alongside whatever repos activated the tile). */
const railed = computed(() => pinned === undefined);

const scoped = computed(() => (repo.value === undefined ? byRepo.value : byRepo.value.filter((group) => group.repo === repo.value)));

/* A chore that does not APPLY here is not a row under any filter — there is no Dockerfile to slim, no pipeline to
 * tighten, no documentation to re-read, and listing it as "clear" would claim we checked something that does not
 * exist. It is not hidden either: <RepoScope> counts them in one line and opens to every one of them and why, so
 * "why is there no Docker chore in this repository?" has an answer one click away rather than a support question. */
const shown = (verdict: ChoreVerdict): boolean =>
    verdict.state !== `not-applicable` && (filter.value === `all` || verdict.state === `due` || verdict.state === `snoozed`);

/* Chore-major within the scope: under "All repositories" the same chore's rows from every repository sit together,
 * which is what makes the repository name on the row the thing being compared. CHORES is already in the book's
 * order, which is kind order, so the groups below come out in reading order for free. */
const rows = computed(() =>
    CHORES.flatMap((chore) => scoped.value.flatMap((group) => group.verdicts.filter((verdict) => verdict.chore.id === chore.id && shown(verdict)))),
);

const groups = computed(() =>
    CHORE_KINDS.flatMap((spec) => {
        const kindRows = rows.value.filter((verdict) => verdict.chore.kind === spec.kind);
        // A kind with nothing to show under the current filter drops out rather than rendering an empty heading.
        if (kindRows.length === 0) {
            return [];
        }
        return [
            {
                kind: spec.kind,
                label: spec.label,
                caption: spec.caption,
                rows: kindRows,
                // The heading counts what is DUE, not how many rows are under it: under "Everything" a group of
                // six with one due is a very different heading from a group of six with six.
                due: kindRows.filter((verdict) => verdict.state === `due`).length,
            },
        ];
    }),
);

// The freshness statement is about ONE repository's measurements, so it renders when the scope is one repository —
// which "All repositories" also is in a workspace that only has one, and that is the right answer there too.
const only = computed(() => (scoped.value.length === 1 ? scoped.value[0] : undefined));
// Under a wider scope the repository is what tells two otherwise identical rows apart, so the row carries it.
const showRepo = computed(() => scoped.value.length > 1);

const scopeDue = computed(() => scoped.value.flatMap((group) => group.verdicts).filter((verdict) => verdict.state === `due`).length);

/* Acknowledge whatever is currently on screen, whenever it changes while this page is open. `immediate` because
 * the common case is arriving here BECAUSE the tile was lit — the first render is the moment the evidence was
 * seen. Idempotent by digest, so the repeated firing this watcher does costs one comparison and no write. It is
 * the RENDERED rows, not every verdict in the workspace: acknowledging a repository the reader has not opened
 * would spend the badge on evidence nobody looked at. */
watch(
    rows,
    (verdicts) => {
        void acknowledge(verdicts);
    },
    { immediate: true },
);

// Finished runs become ledger rows here, on the same data the page already holds — see useRuns.promote for why
// the agent writes a file and the browser does the recording. Workspace-wide on purpose: a run that landed is a
// fact about the ledger, not about what is currently in view.
const ledgerRunIds = computed(
    () =>
        new Set(byRepo.value.flatMap((group) => group.verdicts).flatMap((verdict) => (verdict.lastRun === undefined ? [] : [verdict.lastRun.runId]))),
);
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

// Re-run one of the scope's probes ahead of its TTL. Reads the repository off the scope rather than taking it
// from the strip, because the strip is only ever rendered for one and re-emitting a prop is a longer way to say
// the same thing.
const onRefreshProbe = (id: string): void => {
    const at = only.value?.repo;
    if (at === undefined) {
        return;
    }
    void attempt(`refresh that measurement`, () => refreshProbe(at, id));
};

// `pick` is set only when the reader used the caret beside this chore's button; otherwise the daemon opens the
// session on the sandbox's agent-run list, which is the ordinary path.
const onStart = (verdict: ChoreVerdict, pick: AgentRunChoice | undefined): void => {
    void attempt(`start that turn`, async () => {
        // Straight into the conversation it just started: the turn IS the work, and a page that spawns an agent
        // and then keeps you on the page has hidden the only thing you now care about. The chore row stays
        // behind, and will show the run when you come back.
        api.chat.openSession(conversationIdOf(await start(verdict, pick)));
    });
};
</script>

<template>
    <SplitView
        title="Maintenance"
        :description="`What ${repo === undefined ? `this workspace` : repoLabel(repo)} is owed, what measured it, and what has already been done about it.`"
    >
        <template #actions>
            <Segmented
                v-model="filter"
                size="xs"
                :options="[
                    { label: `Needs attention`, value: `attention`, badge: scopeDue, title: `Chores that are due or snoozed` },
                    { label: `Everything`, value: `all`, title: `Every chore in the book, including the clear and the unmeasured` },
                ]"
            />
            <PageAction quiet icon="refresh" label="Refresh" hint="Re-read the evidence" :disabled="busy" @click="void refresh()" />
        </template>

        <template #strips>
            <div v-if="notice" :class="cmp.alertWarning()">{{ notice }}</div>
            <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>

            <!-- What this repository can be asked and what we actually asked it. Above both panes because it is a
                 statement about the scope, not a row in the list it qualifies. -->
            <RepoScope
                v-if="only"
                :probes="only.probes"
                :inapplicable="only.verdicts.filter((verdict) => verdict.state === `not-applicable`)"
                :busy="busy"
                @refresh="onRefreshProbe"
            />
        </template>

        <template v-if="railed" #rail>
            <RepoRail v-model="repo" :repos="repos" />
        </template>

        <template #detail>
            <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
                <!-- Nothing has come back yet — including the window where the sandbox handshake still gates the
                     fetch. Show the book's shape rather than a sentence, so the page that arrives is the page you
                     were already looking at. -->
                <MaintenanceSkeleton v-if="isPending" />

                <!-- The empty state under "Needs attention" is the one this design most wants to be reachable, so
                     it says what was checked rather than congratulating anyone. -->
                <div v-else-if="groups.length === 0" class="flex flex-col items-start gap-2 py-10">
                    <p class="text-sm text-content">Nothing needs attention.</p>
                    <p class="max-w-[60ch] text-xs text-subtle">
                        Every chore in the book is either clear or waiting on a measurement. Switch to Everything to see what was checked, when, and
                        what could not be measured at all.
                    </p>
                    <Button size="small" severity="secondary" text label="Show everything" @click="filter = `all`" />
                </div>

                <!-- ONE GROUP PER KIND, in the book's own order — the four claims the page makes, each with the
                     sentence that argues for it (CHORE_KINDS) beside the heading. -->
                <template v-else>
                    <RowGroup
                        v-for="group in groups"
                        :key="group.kind"
                        :label="group.label"
                        :count="group.due === 0 ? undefined : group.due"
                        :caption="group.caption"
                    >
                        <ChoreRow
                            v-for="verdict in group.rows"
                            :key="rowKey(verdict)"
                            :verdict="verdict"
                            :run="latestByChore.get(rowKey(verdict))"
                            :expanded="expanded === rowKey(verdict)"
                            :show-repo="showRepo"
                            :busy="busy"
                            @toggle="expanded = expanded === rowKey(verdict) ? undefined : rowKey(verdict)"
                            @start="(pick) => onStart(verdict, pick)"
                            @snooze="void attempt(`snooze that chore`, () => snooze(verdict, Date.now() + SNOOZE_MS))"
                            @unsnooze="void attempt(`un-snooze that chore`, () => snooze(verdict, 0))"
                            @open="(conversationId) => api.chat.openSession(conversationId)"
                        />
                    </RowGroup>
                </template>
            </div>
        </template>
    </SplitView>
</template>
