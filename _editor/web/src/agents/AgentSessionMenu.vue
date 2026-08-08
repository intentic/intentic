<script setup lang="ts">
import { computed } from "vue";
import { effectiveAutoLand, landedAway } from "../composables/agents/agentStatus";
import type { useAgentChanges } from "../composables/agents/useAgentChanges";
import { useAgents } from "../composables/agents/useAgents";
import { useRole } from "../composables/sandbox/useRole";
import { landsByDefault } from "../composables/sandbox/rules";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";

/* What you do to a SESSION, as opposed to what you do to its diff — refresh, land, hold, archive, discard.
 * Width-agnostic body (Popover on desktop, BottomSheet on mobile), the same shape ChatModeMenu has.
 *
 * These five used to sit permanently in the review's toolbar, four of them competing with the diff for the
 * reader's attention on every file they scanned — with the destructive one a few pixels from the primary one.
 * They are once-per-session decisions: you archive an agent when you are done with it, not while reading its
 * third file. So they live behind one glyph next to the status chip that says which of them is even relevant,
 * and the toolbar goes back to being about the review.
 *
 * Land stays out on desktop, as a labelled button in the header — it is the reason this page exists. On a phone
 * there is no room for it beside the Chat|Changes switch, so it is the first item here instead. */

const { changes, agentId, landInMenu } = defineProps<{
    agentId: string;
    // The review's ONE state instance, owned by AgentDetail — a second useAgentChanges() would give this menu
    // its own busy/error flags, so a land fired here would leave the panel's spinners saying nothing happened.
    changes: ReturnType<typeof useAgentChanges>;
    // Mobile, where Land has no room in the header row: it becomes this menu's first item.
    landInMenu: boolean;
    streaming: boolean;
}>();
const emit = defineEmits<{ selected: []; discard: [] }>();

const { agentById, restore, busyIds } = useAgents();
const archived = computed(() => agentById(agentId)?.archivedAt !== undefined);
/* WORK THIS SESSION LANDED THAT THE WORKSPACE NO LONGER HOLDS — the reason "Land now" above stands down.
 *
 * The menu item it replaces was the sharpest form of the problem: with everything recorded as landed, its
 * caption read "Already in your workspace" over a tree the user had emptied of it, and the item was greyed out
 * so there was nothing to press either. Read off the roster rather than off the diff, because the diff is the
 * agent's own branch and the branch is exactly what has NOT changed. */
const away = computed(() => {
    const agent = agentById(agentId);
    return agent === undefined || agent.archivedAt !== undefined ? undefined : landedAway(agent);
});
// Both directions claim the same per-id counter in the fleet store, so one flag covers the round trip either way.
const archiveBusy = computed(() => busyIds.value.includes(agentId));

/* THE HOLD TOGGLE — this agent's land-at-completion posture. It reads the EFFECTIVE value (the agent's
 * override, else the sandbox-wide setting — Sandbox ▸ Agent owns the default), and a click flips it FOR THIS
 * AGENT only. Flipping back to what the sandbox already says clears the override entirely (null), so agents
 * don't accumulate frozen overrides that quietly stop following the global toggle. Deliberately legal
 * mid-turn: the daemon reads the value at turn COMPLETION, so pressing hold while the agent works is exactly
 * "keep THIS turn's work on the branch" — the press that matters most. */
const { settings: sandboxSettings } = useSandboxSettings();
const sandboxLands = computed(() => landsByDefault(sandboxSettings.value?.rules ?? []));
const autoLandOn = computed(() => effectiveAutoLand(agentById(agentId), sandboxLands.value));
const toggleAutoLand = (): void => {
    const next = !autoLandOn.value;
    void changes.setAutoLand(next === sandboxLands.value ? null : next);
    emit(`selected`);
};

// The ship-tier items (land, re-land, auto-land posture, discard) leave the menu below maintainer rather
// than sit disabled in it: a collaborator's asking press lives on the card as "Request land", and a menu of
// grey rows teaches people the menu is broken, not that a tier exists.
const { canShip } = useRole();

const run = (action: () => void): void => {
    action();
    emit(`selected`);
};

// The cumulative land — "Land again" (see `away`). Through `run` like every other item, so the menu closes on
// the press and the panel's own busy/error line owns the round trip.
const relandNow = (): void => run(() => changes.land(`check`, `cumulative`));

const ITEM = `flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-overlay disabled:opacity-40 disabled:hover:bg-transparent max-md:py-3`;
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-if="landInMenu && away === undefined && canShip"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || streaming || changes.pending.value.length === 0"
            @click="run(() => changes.land())"
        >
            <Icon name="check" class="mt-0.5 text-xs text-success" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land now</span>
                <span class="text-2xs text-subtle">
                    {{
                        streaming
                            ? `Wait for the agent turn to finish`
                            : changes.pending.value.length === 0
                              ? `Already in your workspace`
                              : `Applies ${changes.pending.value.length} change(s) to your workspace`
                    }}
                </span>
            </span>
        </button>
        <!-- THE WAY BACK, where the session's own decisions live. It replaces "Land now" rather than joining
             it, because the two are never both the honest offer: with landed work missing from the tree, a
             plain land carries the remainder and leaves the missing part exactly as missing, which is the one
             outcome that looks like it worked. Quiet like everything else in this menu — the card is where the
             fact is announced; this is just the second place the press can be found. -->
        <button v-if="away !== undefined && canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || streaming" @click="relandNow">
            <Icon name="undo" class="mt-0.5 text-xs text-warning" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land again</span>
                <span class="text-2xs text-subtle">{{ streaming ? `Wait for the agent turn to finish` : away.text }}</span>
            </span>
        </button>
        <button type="button" :class="ITEM" @click="run(() => changes.refresh())">
            <Icon name="refresh" class="mt-0.5 text-xs text-subtle" :spin="changes.loading.value" />
            <span class="text-sm text-content md:text-xs">Refresh</span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || archived" @click="toggleAutoLand">
            <Icon :name="autoLandOn ? 'lock' : 'unlock'" class="mt-0.5 text-xs" :class="autoLandOn ? 'text-subtle' : 'text-link'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ autoLandOn ? `Hold work on the branch` : `Land automatically` }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        autoLandOn
                            ? `Finished turns land into your workspace by themselves. Hold keeps this agent's future work on its branch until you press Land now.`
                            : `Holding: finished work waits on this agent's branch. Switch back to landing at turn completion.`
                    }}
                </span>
            </span>
        </button>
        <!-- Two endings, and the copy is what keeps them apart: archive KEEPS everything and only takes the
             agent off the board, discard is the one that throws work away. -->
        <button
            v-if="!archived"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || archiveBusy || streaming"
            @click="run(() => changes.archive())"
        >
            <Icon name="box" class="mt-0.5 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Archive</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? `Wait for the agent turn to finish` : `The branch, diff and conversation are kept` }}
                </span>
            </span>
        </button>
        <button v-else type="button" :class="ITEM" :disabled="archiveBusy" @click="run(() => restore([agentId]))">
            <Icon name="history" class="mt-0.5 text-xs text-link" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-link md:text-xs">Restore</span>
                <span class="text-2xs text-subtle">Puts it back on the board</span>
            </span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || streaming" @click="run(() => emit(`discard`))">
            <Icon name="trash" class="mt-0.5 text-xs text-danger" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-danger md:text-xs">Discard</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? `Wait for the agent turn to finish` : `Drops this agent's branch and worktree` }}
                </span>
            </span>
        </button>
    </div>
</template>
