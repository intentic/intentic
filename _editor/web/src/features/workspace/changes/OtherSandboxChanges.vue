<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import {
    dismissPushError,
    hasOtherSandboxes,
    ledgerKey,
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
import { landOnAfterSwitch } from "../../sandbox/switching/sandboxScreen";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useT } from "@intentic/ui/i18n";

// Ledger of what other sandboxes hold: one line per repo, showing unpushed or uncommitted work with no merged tree to
// diff against. Folded at the foot of the Changes panel by default, staying open once opened, so it never pushes the
// panel above off screen. Renders nothing on a single-sandbox account, or when every box is clean.

const t = useT();

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
        parts.push(
            outgoing.commits > 0
                ? t(`workspace.otherSandboxChanges.unpushed`, { count: outgoing.commits }, outgoing.commits)
                : t(`workspace.otherSandboxChanges.unpublishedWork`),
        );
    }
    if (uncommittedAcross.value > 0) {
        parts.push(t(`workspace.otherSandboxChanges.uncommitted`, { count: uncommittedAcross.value }, uncommittedAcross.value));
    }
    return parts.join(`, `);
});

// Reported separately from the summary: 'nothing outstanding' and 'two machines didn't answer' are different claims
// that must not merge into one.
const silentLine = computed(() =>
    silent.value.length === 0
        ? undefined
        : t(
              `workspace.otherSandboxChanges.notAnswering`,
              { names: silent.value.map((box) => box.sandbox.name).join(`, `), count: silent.value.length },
              silent.value.length,
          ),
);

// ReviewPanel's leading-glyph slot: 10px, so a chevron here sits in the same column as the repo rows' above.
const LEAD = `flex w-2.5 shrink-0 items-center justify-center`;

// Absent when there's nothing outstanding, rather than showing a permanent all-clear row.
const show = computed(() => hasOtherSandboxes.value && (rows.value.length > 0 || silent.value.length > 0));

// Lives here, not in changesAcross, so that module doesn't need a router import every node-environment test would
// carry. Destination is recorded before the switch, so it doesn't land on whatever the target was last showing.
const openWorkspaceIn = (sandboxId: string): void => {
    landOnAfterSwitch(sandboxId, `/workspace`);
    useSandbox().select(sandboxId);
};

const sendable = (row: LedgerRow): boolean => !row.unreadable && (row.ahead > 0 || row.publish);
// Publish for a branch never pushed, Push otherwise; a branch that's both is sent by one ordinary push.
const sendVerb = (row: LedgerRow): string =>
    row.publish && row.ahead === 0 ? t(`workspace.otherSandboxChanges.publish`) : t(`workspace.otherSandboxChanges.push`);

const detail = (row: LedgerRow): string => {
    if (row.unreadable) {
        return t(`workspace.otherSandboxChanges.unreadable`);
    }
    const parts: string[] = [];
    if (row.ahead > 0) {
        parts.push(t(`workspace.otherSandboxChanges.toPush`, { count: row.ahead }, row.ahead));
    }
    if (row.publish) {
        parts.push(t(`workspace.otherSandboxChanges.neverPublished`));
    }
    if (row.uncommitted > 0) {
        parts.push(t(`workspace.otherSandboxChanges.uncommitted`, { count: row.uncommitted }, row.uncommitted));
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
            <!-- The Changes list's own grid (ReviewPanel's LEAD): the chevron in the repo chevrons' column, the server
                 glyph on the repo names' column, so this heading reads as one more block of that list. -->
            <span :class="LEAD"><Icon :name="open ? 'chevron-down' : 'chevron-right'" class="text-2xs text-subtle" /></span>
            <span :class="LEAD"><Icon name="server" class="text-2xs text-subtle" /></span>
            <span class="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-muted">{{
                t(`workspace.otherSandboxChanges.inOtherSandboxes`)
            }}</span>
            <span v-if="summary" class="shrink-0 text-2xs text-warning">{{ summary }}</span>
        </button>

        <!-- Name the boxes so a summary cannot be mistaken for a complete list. -->
        <p v-if="silentLine !== undefined" class="flex items-center gap-1.5 py-0.5 pl-5 pr-1 text-2xs text-subtle">
            <span class="min-w-0 flex-1 truncate">{{ silentLine }}</span>
            <!-- Pulled out by its own padding, so the word ends on the gutter Commit and the row glyphs end on. -->
            <button type="button" class="-mr-1 shrink-0 rounded px-1 py-0.5 text-link transition-colors hover:bg-overlay" @click="refreshChangesAcross()">
                {{ t(`ui.action.retry`) }}
            </button>
        </p>

        <template v-if="open">
            <Notice
                v-if="pushRowError !== undefined"
                tone="danger"
                size="xs"
                class="mx-1 mt-1"
                :dismiss-label="t(`ui.action.dismiss`)"
                @dismiss="dismissPushError()"
            >
                {{ pushRowError }}
            </Notice>

            <div v-for="row in rows" :key="ledgerKey(row)" class="flex min-w-0 items-center gap-1.5 py-1 pl-5 pr-1">
                <div class="min-w-0 flex-1">
                    <!-- Box names lead repository names so the machine context is clear. -->
                    <p class="min-w-0 truncate text-2xs text-content">
                        <span class="text-muted">{{ row.sandboxName }}</span>
                        <span class="px-1 text-subtle">/</span>{{ row.repo }}
                    </p>
                    <p class="min-w-0 truncate text-2xs" :class="row.unreadable ? 'text-danger' : 'text-subtle'">{{ detail(row) }}</p>
                </div>
                <Button
                    v-if="sendable(row)"
                    size="small"
                    tier="boring"
                    class="shrink-0"
                    :disabled="pushingRow !== undefined"
                    :label="pushingRow === ledgerKey(row) ? t(`ui.status.sending`) : sendVerb(row)"
                    v-tooltip.top="{
                        title: sendVerb(row),
                        rows: [{ label: t(`shared.sandboxHub`), value: row.sandboxName }],
                        note: t(`workspace.otherSandboxChanges.checksRunThere`),
                    }"
                    @click="pushRow(row)"
                />
                <!-- Unsupported actions remain on the owning machine. -->
                <button
                    type="button"
                    :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `shrink-0`)"
                    :aria-label="t(`workspace.otherSandboxChanges.open`, { sandboxName: row.sandboxName })"
                    v-tooltip.top="t(`workspace.otherSandboxChanges.open`, { sandboxName: row.sandboxName })"
                    @click="openWorkspaceIn(row.sandboxId)"
                >
                    <Icon name="arrow-right" class="text-2xs" />
                </button>
            </div>
        </template>
    </section>
</template>
