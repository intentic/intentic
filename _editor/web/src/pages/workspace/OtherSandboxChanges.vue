<script setup lang="ts">
import { Button } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import {
    dismissPushError,
    hasOtherSandboxes,
    type LedgerRow,
    ledgerRows,
    outgoingAcross,
    pushingRow,
    pushRow,
    pushRowError,
    refreshChangesAcross,
    silentChangeBoxes,
    subscribeChanges,
    uncommittedAcross,
} from "../../composables/workspace/changesAcross";
import { landOnAfterSwitch } from "../../composables/sandbox/sandboxScreen";
import { useSandbox } from "../../composables/sandbox/useSandbox";

/* WHAT THE OTHER SANDBOXES ARE HOLDING, at the foot of the Changes panel.
 *
 * The panel above it is a REVIEW: every uncommitted path in this workspace, stageable, committable, discardable.
 * This is deliberately not that, and could not be. Two sandboxes' `/work/intentic` are two checkouts whose paths
 * collide and neither of which contains the other, so there is no merged tree to browse and no row here that a
 * diff could be opened from. What crosses sandboxes is not files, it is EXPOSURE: how much work exists on a
 * machine and nowhere else. So this is a ledger, one line per repo, and its verbs are the two that make sense
 * at a distance: send it, or go there.
 *
 * IT IS AT THE FOOT AND IT IS FOLDED, which is the whole of its claim on the reader's attention. The work in
 * front of you outranks the work on another machine every time, so this never pushes a row of the panel above
 * it off the screen; what it does is stop "there are eleven commits on the laptop that have never been pushed"
 * from being a fact nobody can learn without going and looking. Open once and it stays open, per window.
 *
 * WHY THIS IS WORTH A SURFACE AT ALL is the sentence outgoingWork.ts already makes about one box: a sandbox is
 * a machine that can go away. Everything the local panel says about that risk was, until this, said about
 * exactly one of the user's machines.
 *
 * It draws NOTHING on a one-sandbox account, and nothing when every other box is clean: an empty heading
 * explaining a feature you have no use for is worse than no heading. */

const open = ref(false);
const release = subscribeChanges();
onUnmounted(release);

const rows = computed(() => ledgerRows.value);
const silent = computed(() => silentChangeBoxes.value);

// The one line the folded heading carries, and the reason to unfold it. Commits first: an unpushed commit is
// the more recoverable-looking and less recoverable of the two exposures, since it reads as saved.
const summary = computed(() => {
    const parts: string[] = [];
    const outgoing = outgoingAcross.value;
    if (outgoing !== undefined) {
        parts.push(outgoing.commits > 0 ? `${outgoing.commits} unpushed` : `unpublished work`);
    }
    if (uncommittedAcross.value > 0) {
        parts.push(`${uncommittedAcross.value} uncommitted`);
    }
    return parts.join(`, `);
});

// Silence is reported as its own clause rather than folded into the summary: "nothing outstanding" and "two
// machines didn't answer" are opposite claims, and a heading that ran them together would say the first while
// meaning the second.
const silentLine = computed(() =>
    silent.value.length === 0
        ? undefined
        : `${silent.value.map((box) => box.sandbox.name).join(`, `)} ${silent.value.length === 1 ? `isn't` : `aren't`} answering`,
);

// Nothing outstanding anywhere, and nothing unaccounted for. The section is absent rather than reassuring: a
// permanent "all clear" row is the statistic this app's badge rule keeps off every other surface.
const show = computed(() => hasOtherSandboxes.value && (rows.value.length > 0 || silent.value.length > 0));

/* GO AND WORK IN THAT BOX. The row's other press, and the one that costs the switch: everything the ledger
 * itself offers is a count and a push, and anything more (reading the diff, committing, running that box's own
 * pre-push suite) needs the workspace of the machine it is on.
 *
 * It lives HERE rather than beside the data it acts on, because a switch reaches the router and the store
 * behind this section must not: `agentActions` re-reads that store after a land, and an import edge from there
 * to the router is one every node-environment test in the app has to carry.
 *
 * The destination is recorded before the selection moves, for the reason sandboxScreen's own helper gives: the
 * switch otherwise lands on whatever that box was last showing, which is a detour taken from the one direction
 * where the caller knew where it was going. */
const openWorkspaceIn = (sandboxId: string): void => {
    landOnAfterSwitch(sandboxId, `/workspace`);
    useSandbox().select(sandboxId);
};

const rowKey = (row: LedgerRow): string => `${row.sandboxId}:${row.repo}`;
const sendable = (row: LedgerRow): boolean => !row.unreadable && (row.ahead > 0 || row.publish);
// The verb the row's own state earns, the same split the local panel makes: a branch git has never pushed is
// Published, everything else is Pushed, and a branch that is both is sent by one ordinary push.
const sendVerb = (row: LedgerRow): string => (row.publish && row.ahead === 0 ? `Publish` : `Push`);

const detail = (row: LedgerRow): string => {
    if (row.unreadable) {
        return `git couldn't read this repo`;
    }
    const parts: string[] = [];
    if (row.ahead > 0) {
        parts.push(`${row.ahead} to push`);
    }
    if (row.publish) {
        parts.push(`never published`);
    }
    if (row.uncommitted > 0) {
        parts.push(`${row.uncommitted} uncommitted`);
    }
    return parts.join(` · `);
};
</script>

<template>
    <section v-if="show" data-other-sandboxes class="mt-2 border-t border-line px-1 pt-1">
        <button
            type="button"
            class="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1 text-left transition-colors hover:bg-content/5"
            :aria-expanded="open"
            @click="open = !open"
        >
            <Icon :name="open ? 'chevron-down' : 'chevron-right'" class="w-2.5 shrink-0 text-[0.6rem] text-subtle" />
            <Icon name="server" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-muted">In other sandboxes</span>
            <span v-if="summary" class="shrink-0 text-2xs text-warning">{{ summary }}</span>
        </button>

        <!-- Named boxes, not a count, and outside the fold: a reader deciding whether the summary above is the
             whole story needs to know it is missing one, before choosing not to open this. -->
        <p v-if="silentLine !== undefined" class="flex items-center gap-1.5 py-0.5 pl-4 pr-1 text-2xs text-subtle">
            <span class="min-w-0 flex-1 truncate">{{ silentLine }}</span>
            <button type="button" class="shrink-0 rounded px-1 py-0.5 text-link transition-colors hover:bg-overlay" @click="refreshChangesAcross()">
                Retry
            </button>
        </p>

        <template v-if="open">
            <p v-if="pushRowError !== undefined" class="mt-1 flex items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1 text-2xs text-danger">
                <span class="min-w-0 flex-1">{{ pushRowError }}</span>
                <button type="button" aria-label="Dismiss" class="shrink-0 rounded p-0.5 hover:bg-overlay" @click="dismissPushError()">
                    <Icon name="times" class="text-2xs" />
                </button>
            </p>

            <div v-for="row in rows" :key="rowKey(row)" class="flex min-w-0 items-center gap-1.5 py-1 pl-4 pr-1">
                <div class="min-w-0 flex-1">
                    <!-- The BOX first and the repo second, because the box is what the reader is orienting by:
                         the same repo name appears in several of them, and which machine it is on is the whole
                         question this section answers. -->
                    <p class="min-w-0 truncate text-2xs text-content">
                        <span class="text-muted">{{ row.sandboxName }}</span>
                        <span class="px-1 text-subtle">/</span>{{ row.repo }}
                    </p>
                    <p class="min-w-0 truncate text-2xs" :class="row.unreadable ? 'text-danger' : 'text-subtle'">{{ detail(row) }}</p>
                </div>
                <Button
                    v-if="sendable(row)"
                    size="small"
                    severity="secondary"
                    class="shrink-0"
                    :disabled="pushingRow !== undefined"
                    :label="pushingRow === rowKey(row) ? 'Sending…' : sendVerb(row)"
                    v-tooltip.top="`${sendVerb(row)} straight from here. Its own pre-push checks run in that sandbox, not this one`"
                    @click="pushRow(row)"
                />
                <!-- Everything this ledger cannot do: read the diff, commit, run the checks. One press, and it
                     says which machine it is taking you to rather than just moving the app under the reader. -->
                <button
                    type="button"
                    class="shrink-0 rounded-md p-1 text-subtle transition-colors hover:bg-overlay hover:text-content"
                    :aria-label="`Open ${row.sandboxName}`"
                    v-tooltip.top="`Switch this window to ${row.sandboxName}`"
                    @click="openWorkspaceIn(row.sandboxId)"
                >
                    <Icon name="arrow-right" class="text-2xs" />
                </button>
            </div>
        </template>
    </section>
</template>
