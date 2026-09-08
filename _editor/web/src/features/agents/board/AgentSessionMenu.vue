<script setup lang="ts">
import { computed } from "vue";
import { effectiveAutoLand, effectiveLimitMove, effectiveLimitResume, landedAway, limited, writingNow } from "../fleet/agentStatus";
import type { useAgentChanges } from "../review/useAgentChanges";
import { useAgents } from "../fleet/useAgents";
import { useRole } from "../../sandbox/secrets/useRole";
import { landsByDefault } from "../../sandbox/environment/rules";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";

// Session-level actions (refresh, land, hold, archive, discard), as opposed to diff actions; once-per-session decisions
// live behind one glyph rather than permanently cluttering the toolbar.
// Land stays a labelled header button on desktop; on mobile, where it has no room beside Chat|Changes, it's this menu's
// first item instead.

const { changes, agentId, landInMenu } = defineProps<{
    agentId: string;
    // AgentDetail's one useAgentChanges instance; a second one here would desync the panel's busy/error state.
    changes: ReturnType<typeof useAgentChanges>;
    // Mobile, where Land has no room in the header row: it becomes this menu's first item.
    landInMenu: boolean;
    streaming: boolean;
}>();
// Goes up like `discard`: the warning is a modal, and modals live on the page, not inside a closing menu.
const emit = defineEmits<{ selected: []; discard: []; forceLand: [] }>();

const { agentById, restore, busyIds, setResumeAfterLimit, setMoveAfterLimit } = useAgents();
const archived = computed(() => agentById(agentId)?.archivedAt !== undefined);
// Work this session landed that the workspace no longer holds; the reason "Land now" stands down for it.
// Read off the roster, not the diff: the diff is the agent's own branch, which is exactly what hasn't changed.
const away = computed(() => {
    const agent = agentById(agentId);
    return agent === undefined || agent.archivedAt !== undefined ? undefined : landedAway(agent);
});
// Archive and restore share the same per-id busy counter, so one flag covers either direction.
const archiveBusy = computed(() => busyIds.value.includes(agentId));

// Reads the effective value (this agent's override, else the sandbox default) and flips it for this agent only.
// Flipping back to the sandbox's own value clears the override to null, rather than leaving a frozen copy of it; legal
// mid-turn, since the daemon reads it only at turn completion.
const { settings: sandboxSettings } = useSandboxSettings();
const sandboxLands = computed(() => landsByDefault(sandboxSettings.value?.rules ?? []));
const autoLandOn = computed(() => effectiveAutoLand(agentById(agentId), sandboxLands.value));
const toggleAutoLand = async (): Promise<void> => {
    const next = !autoLandOn.value;
    emit(`selected`);
    await changes.setAutoLand(next === sandboxLands.value ? null : next);
};

// Shown only on a card actually waiting on a spent allowance, unlike the always-present hold toggle.
// Same three-state grammar as the hold toggle: flipping back to the sandbox's value clears the override rather than
// freezing a copy of it.
const limitedCard = computed(() => {
    const agent = agentById(agentId);
    return agent !== undefined && limited(agent) ? agent : undefined;
});
const sandboxSendsAgain = computed(() => sandboxSettings.value?.resumeAfterLimit ?? false);
const sendsAgainOn = computed(() => effectiveLimitResume(agentById(agentId), sandboxSendsAgain.value));
const toggleSendsAgain = async (): Promise<void> => {
    const next = !sendsAgainOn.value;
    emit(`selected`);
    await setResumeAfterLimit(agentId, next === sandboxSendsAgain.value ? null : next);
};

// The other answer to the same wall: moves the held turn to another account of the same provider with room, instead of
// waiting for reset.
const sandboxMoves = computed(() => sandboxSettings.value?.moveAfterLimit ?? false);
const movesOn = computed(() => effectiveLimitMove(agentById(agentId), sandboxMoves.value));
const toggleMoves = async (): Promise<void> => {
    const next = !movesOn.value;
    emit(`selected`);
    await setMoveAfterLimit(agentId, next === sandboxMoves.value ? null : next);
};

// Ship-tier items are hidden below maintainer, not shown disabled: a collaborator's request lives on the card instead.
// A menu of grey rows reads as broken, not as tiered.
const { canShip } = useRole();

const run = (action: () => void): void => {
    action();
    emit(`selected`);
};

// Same split as the header button (AgentDetail); made independently here since either one can be the press.
// Archive and discard below still gate on `streaming`; the land items follow `writing` instead, since a turn parked on
// a question isn't writing.
const writing = computed(() => {
    const agent = agentById(agentId);
    return agent !== undefined && writingNow(agent);
});
// Every land in this menu goes through here: warns while the agent writes, otherwise lands directly.
const pressLand = (land: () => void): void => {
    if (writing.value) {
        emit(`forceLand`);
        emit(`selected`);
        return;
    }
    run(land);
};
// Land again (see `away`): the span isn't decided here, but read from the same landed-presence reading, so this and the
// header button never disagree.
// Goes through `run`, like every other item, so the menu closes and the panel's own busy/error line owns the round
// trip.
const relandNow = (): void => pressLand(() => changes.land());

const ITEM = `flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-overlay disabled:opacity-40 disabled:hover:bg-transparent max-md:py-3`;
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-if="landInMenu && away === undefined && canShip"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || changes.pending.value.length === 0"
            @click="pressLand(() => changes.land())"
        >
            <Icon name="check" class="mt-0.5 text-xs text-success" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land now</span>
                <span class="text-2xs text-subtle">
                    {{
                        writing
                            ? `The agent is still writing: you'll be asked to confirm`
                            : changes.pending.value.length === 0
                              ? `Already in your workspace`
                              : streaming
                                ? `Applies what the agent has written so far`
                                : `Applies ${changes.pending.value.length} change(s) to your workspace`
                    }}
                </span>
            </span>
        </button>
        <!--
            Replaces "Land now" rather than joining it: with landed work missing, a plain land would leave that part
            exactly as missing.
            This is just a second place to find the press the card already announces.
        -->
        <button v-if="away !== undefined && canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value" @click="relandNow">
            <Icon name="undo" class="mt-0.5 text-xs text-warning" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Land again</span>
                <span class="text-2xs text-subtle">{{ writing ? `The agent is still writing, you'll be asked to confirm` : away.text }}</span>
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
        <!--
            The allowance posture, shown only on a card actually waiting on one.
            Kept off the card itself: the card already has a press that spends money now, and a second one arming
            future spend would be two decisions in one line.
        -->
        <button v-if="limitedCard !== undefined" type="button" :class="ITEM" :disabled="archived" @click="toggleSendsAgain">
            <Icon :name="sendsAgainOn ? 'clock' : 'refresh'" class="mt-0.5 text-xs" :class="sendsAgainOn ? 'text-link' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{
                    sendsAgainOn ? `Stop sending this again by itself` : `Send again when the allowance is back`
                }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        sendsAgainOn
                            ? `This turn goes again by itself at the reset. Stopping leaves it here to send by hand.`
                            : `Nothing sends it for you. Arm it and this turn goes once, at the hour the provider named.`
                    }}
                </span>
            </span>
        </button>
        <button v-if="limitedCard !== undefined" type="button" :class="ITEM" :disabled="archived" @click="toggleMoves">
            <Icon name="user" class="mt-0.5 text-xs" :class="movesOn ? 'text-link' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ movesOn ? `Stop moving this to another account` : `Move to another account when spent` }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        movesOn
                            ? `A refused turn moves to a connected account of the same provider with room, at once, on this chat's behalf.`
                            : `Spends a second account on this chat's behalf; with none that has room, it waits as the row above says.`
                    }}
                </span>
            </span>
        </button>
        <!-- Archive keeps everything and only removes the agent from the board; discard actually throws work away. -->
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
