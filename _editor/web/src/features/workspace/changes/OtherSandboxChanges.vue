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
} from "./changesAcross";
import { landOnAfterSwitch } from "../../sandbox/client/sandboxScreen";
import { useSandbox } from "../../sandbox/client/useSandbox";

// Ledger of what other sandboxes hold: one line per repo, showing unpushed or uncommitted work with no merged tree to
// diff against. Folded at the foot of the Changes panel by default, staying open once opened, so it never pushes the
// panel above off screen. Renders nothing on a single-sandbox account, or when every box is clean.

const open = ref(false);
const release = subscribeChanges();
onUnmounted(release);

const rows = computed(() => ledgerRows.value);
const silent = computed(() => silentChangeBoxes.value);

// Commits listed first: an unpushed commit reads as saved and so is the less obviously at-risk of the two exposures.
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

// Reported separately from the summary: 'nothing outstanding' and 'two machines didn't answer' are different claims
// that must not merge into one.
const silentLine = computed(() =>
    silent.value.length === 0
        ? undefined
        : `${silent.value.map((box) => box.sandbox.name).join(`, `)} ${silent.value.length === 1 ? `isn't` : `aren't`} answering`,
);

// Absent when there's nothing outstanding, rather than showing a permanent all-clear row.
const show = computed(() => hasOtherSandboxes.value && (rows.value.length > 0 || silent.value.length > 0));

// Lives here, not in changesAcross, so that module doesn't need a router import every node-environment test would
// carry. Destination is recorded before the switch, so it doesn't land on whatever the target was last showing.
const openWorkspaceIn = (sandboxId: string): void => {
    landOnAfterSwitch(sandboxId, `/workspace`);
    useSandbox().select(sandboxId);
};

const rowKey = (row: LedgerRow): string => `${row.sandboxId}:${row.repo}`;
const sendable = (row: LedgerRow): boolean => !row.unreadable && (row.ahead > 0 || row.publish);
// Publish for a branch never pushed, Push otherwise; a branch that's both is sent by one ordinary push.
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

        <!-- Named boxes, not a count, shown outside the fold: a reader needs to know the summary is incomplete before deciding not to open this. -->
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
                    <!--
                        Box name first, repo second: the same repo can appear in several boxes, and which machine it's on is the question this
                        answers.
                    -->
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
                <!-- Everything this ledger can't do (diff, commit, checks) lives on that machine; the label names which one it's taking you to. -->
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
