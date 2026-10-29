<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
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
    type QuietBox,
    quietChangeBoxes,
    refreshChangesAcross,
    sleepingChangeBoxes,
    subscribeChanges,
    uncommittedAcross,
    wakeAndRead,
} from "../../../models/workspace/changes/changesAcross";
import { sleepingOn } from "../../../client/sandbox/wake/sandboxAnswer";
import { landOnAfterSwitch } from "../../../models/sandbox/sandboxScreen";
import { retrySandboxRead } from "../../../client/sandbox/reachability";
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
// The boxes it cannot vouch for, each with the reason it is quiet.
const quiet = computed(() => quietChangeBoxes.value);

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
// that must not merge into one. Nor are 'asleep' and 'not answering' (2026-10-29): a sandbox its own computer put to sleep
// is quiet on purpose and is woken from here, one whose computer is off cannot be, and only a box that should answer and
// does not is said in warning ink.
const retryError = ref<string>();
// The box a press is working on: one at a time, since a wake is a boot on somebody's computer.
const pressing = ref<string>();
const press = async ({ box, answer }: QuietBox): Promise<void> => {
    if (pressing.value !== undefined) {
        return;
    }
    pressing.value = box.sandbox.id;
    retryError.value = undefined;
    try {
        if (answer === `asleep`) {
            if (!(await wakeAndRead(box.sandbox, useSandbox().wake))) {
                retryError.value = t(`workspace.otherSandboxChanges.didNotWake`, { name: box.sandbox.name });
            }
        } else {
            await retrySandboxRead(box.sandbox, useSandbox().wake, refreshChangesAcross);
        }
    } catch (error) {
        retryError.value = errorMessage(error);
    } finally {
        pressing.value = undefined;
    }
};
const quietText = ({ box, answer }: QuietBox): string => {
    const name = box.sandbox.name;
    switch (answer) {
        case `asleep`:
            return pressing.value === box.sandbox.id ? t(`workspace.otherSandboxChanges.waking`, { name }) : t(`workspace.otherSandboxChanges.asleep`, { name });
        case `unwakeable`: {
            const machine = sleepingOn(box.sandbox);
            return machine === undefined
                ? t(`workspace.otherSandboxChanges.asleepComputerOff`, { name })
                : t(`workspace.otherSandboxChanges.asleepMachineOff`, { name, machine });
        }
        case `starting`:
            return t(`workspace.otherSandboxChanges.starting`, { name });
        case `not-answering`:
            return t(`workspace.otherSandboxChanges.notAnswering`, { names: name, count: 1 }, 1);
    }
};
// Wake for a sleeper its computer can start, Retry for a box that should answer; nothing for one whose computer is off,
// which nothing here can start and which this ledger reads again once the list says its computer is back.
const pressLabel = ({ answer }: QuietBox): string | undefined =>
    answer === `asleep` ? t(`workspace.otherSandboxChanges.wake`) : answer === `unwakeable` ? undefined : t(`ui.action.retry`);
const asleepRow = (row: LedgerRow): boolean => sleepingChangeBoxes.value.has(row.sandboxId);

// ReviewPanel's leading-glyph slot: 10px, so a chevron here sits in the same column as the repo rows' above.
const LEAD = `flex w-2.5 shrink-0 items-center justify-center`;

// Absent when there's nothing outstanding, rather than showing a permanent all-clear row.
const show = computed(() => hasOtherSandboxes.value && (rows.value.length > 0 || quiet.value.length > 0));

// Lives here, not in changesAcross, so that module doesn't need a router import every node-environment test would
// carry. Destination is recorded before the switch, so it doesn't land on whatever the target was last showing.
const openWorkspaceIn = (sandboxId: string): void => {
    landOnAfterSwitch(sandboxId, `/workspace`);
    useSandbox().select(sandboxId);
};

// A sleeping box's rows are what it held before it slept: pushing waits until it is awake, one press away on the arrow.
const sendable = (row: LedgerRow): boolean => !row.unreadable && !asleepRow(row) && (row.ahead > 0 || row.publish);
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
    if (asleepRow(row)) {
        parts.push(t(`workspace.otherSandboxChanges.asleepRow`));
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
            <span class="min-w-0 flex-1 truncate text-2xs font-medium text-muted">{{
                t(`workspace.otherSandboxChanges.inOtherSandboxes`)
            }}</span>
            <span v-if="summary" class="shrink-0 text-2xs text-warning">{{ summary }}</span>
        </button>

        <!-- Name the boxes so a summary cannot be mistaken for a complete list. -->
        <p
            v-for="entry in quiet"
            :key="entry.box.sandbox.id"
            class="flex items-center gap-1.5 py-0.5 pl-5 pr-1 text-2xs"
            :class="entry.answer === 'not-answering' ? 'text-warning' : 'text-subtle'"
        >
            <span class="min-w-0 flex-1 truncate">{{ quietText(entry) }}</span>
            <!-- Pulled out by its own padding, so the word ends on the gutter Commit and the row glyphs end on. -->
            <button
                v-if="pressLabel(entry) !== undefined"
                type="button"
                class="-mr-1 shrink-0 rounded px-1 py-0.5 text-link transition-colors hover:bg-overlay"
                :disabled="pressing !== undefined"
                @click="press(entry)"
            >
                {{ pressLabel(entry) }}
            </button>
        </p>

        <Notice v-if="retryError" tone="danger" size="xs">{{ retryError }}</Notice>

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
                    <p
                        class="min-w-0 truncate text-2xs"
                        :class="row.unreadable ? 'text-danger' : 'text-subtle'"
                        v-tooltip.top="
                            asleepRow(row)
                                ? { title: t(`workspace.otherSandboxChanges.asleepTitle`), note: t(`workspace.otherSandboxChanges.asleepRowNote`) }
                                : undefined
                        "
                    >
                        {{ detail(row) }}
                    </p>
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
