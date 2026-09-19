<script setup lang="ts">
import { computed } from "vue";
import { effectiveAutoLand, effectiveLimitMove, effectiveLimitResume, landedAway, limited, writingNow } from "../../fleet/agentStatus";
import type { useAgentChanges } from "../../review/useAgentChanges";
import { useAgents } from "../../fleet/useAgents";
import { useRole } from "../../../sandbox/secrets/useRole";
import { landsByDefault } from "../../../sandbox/environment/rules";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// Session-level actions (refresh, land, hold, archive, discard), as opposed to diff actions; once-per-session decisions
// live behind one glyph rather than permanently cluttering the toolbar.
// Land, Rename and the session name stay in the header on desktop; on a phone, where the row holds the title and
// little else, they are this menu's first items instead.

const t = useT();

const { changes, agentId, phone, renameable, sessionName } = defineProps<{
    agentId: string;
    // AgentDetail's one useAgentChanges instance; a second one here would desync the panel's busy/error state.
    changes: ReturnType<typeof useAgentChanges>;
    // The phone, whose header row dropped Land, Rename and the session chip: they lead this menu.
    phone: boolean;
    // Whether the header would have offered Rename (a local, named agent).
    renameable: boolean;
    // The agent's branch, the session's pasteable name; absent for a draft.
    sessionName?: string | undefined;
    streaming: boolean;
}>();
// Goes up like `discard`: the warning is a modal, and modals live on the page, not inside a closing menu. `rename`
// and `identity` are the header's own presses, handed back to it.
const emit = defineEmits<{ selected: []; discard: []; forceLand: []; rename: []; identity: [] }>();

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
            v-if="phone && away === undefined && canShip"
            type="button"
            :class="ITEM"
            :disabled="changes.actionBusy.value || changes.pending.value.length === 0"
            @click="pressLand(() => changes.land())"
        >
            <Icon name="check" class="mt-0.5 text-xs text-success" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ t(`agents.agentSessionMenu.landNow`) }}</span>
                <span class="text-2xs text-subtle">
                    {{
                        writing
                            ? t(`agents.agentSessionMenu.agentStillWritingYoull`)
                            : changes.pending.value.length === 0
                              ? t(`agents.agentSessionMenu.alreadyInWorkspace`)
                              : streaming
                                ? t(`agents.agentSessionMenu.appliesWhatAgentWritten`)
                                : t(`agents.agentSessionMenu.appliesChangeSTo`, { count: changes.pending.value.length })
                    }}
                </span>
            </span>
        </button>
        <!-- Replaces "Land now" rather than joining it: with landed work missing, a plain land would leave that part exactly as missing. -->
        <button v-if="away !== undefined && canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value" @click="relandNow">
            <Icon name="undo" class="mt-0.5 text-xs text-warning" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ t(`agents.agentSessionMenu.landAgain`) }}</span>
                <span class="text-2xs text-subtle">{{ writing ? t(`agents.agentSessionMenu.agentStillWritingYoull2`) : away.text }}</span>
            </span>
        </button>
        <button v-if="phone && renameable" type="button" :class="ITEM" @click="run(() => emit(`rename`))">
            <Icon name="pencil" class="mt-0.5 text-xs text-subtle" />
            <span class="text-sm text-content md:text-xs">{{ t(`ui.action.rename`) }}</span>
        </button>
        <button v-if="phone && sessionName !== undefined" type="button" :class="ITEM" @click="run(() => emit(`identity`))">
            <Icon name="code" class="mt-0.5 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ t(`agents.agentSessionMenu.sessionName`) }}</span>
                <span class="truncate font-mono text-2xs text-subtle">{{ sessionName }}</span>
            </span>
        </button>
        <button type="button" :class="ITEM" @click="run(() => changes.refresh())">
            <Icon name="refresh" class="mt-0.5 text-xs text-subtle" :spin="changes.fetching.value" />
            <span class="text-sm text-content md:text-xs">{{ t(`ui.action.refresh`) }}</span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || archived" @click="toggleAutoLand">
            <Icon :name="autoLandOn ? 'lock' : 'unlock'" class="mt-0.5 text-xs" :class="autoLandOn ? 'text-subtle' : 'text-link'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{
                    autoLandOn ? t(`agents.agentSessionMenu.holdWorkOnBranch`) : t(`agents.agentSessionMenu.landAutomatically`)
                }}</span>
                <span class="text-2xs text-subtle">
                    {{ autoLandOn ? t(`agents.agentSessionMenu.finishedTurnsLandInto`) : t(`agents.agentSessionMenu.holdingFinishedWorkWaits`) }}
                </span>
            </span>
        </button>
        <!-- The allowance posture, shown only on a card actually waiting on one. -->
        <button v-if="limitedCard !== undefined" type="button" :class="ITEM" :disabled="archived" @click="toggleSendsAgain">
            <Icon :name="sendsAgainOn ? 'clock' : 'refresh'" class="mt-0.5 text-xs" :class="sendsAgainOn ? 'text-link' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{
                    sendsAgainOn ? t(`agents.agentSessionMenu.stopSendingAgainBy`) : t(`agents.agentSessionMenu.sendAgainAllowanceBack`)
                }}</span>
                <span class="text-2xs text-subtle">
                    {{ sendsAgainOn ? t(`agents.agentSessionMenu.turnGoesAgainBy`) : t(`agents.agentSessionMenu.nothingSendsArmTurn`) }}
                </span>
            </span>
        </button>
        <button v-if="limitedCard !== undefined" type="button" :class="ITEM" :disabled="archived" @click="toggleMoves">
            <Icon name="user" class="mt-0.5 text-xs" :class="movesOn ? 'text-link' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{
                    movesOn ? t(`agents.agentSessionMenu.stopMovingToAnother`) : t(`agents.agentSessionMenu.moveToAnotherAccount`)
                }}</span>
                <span class="text-2xs text-subtle">
                    {{ movesOn ? t(`agents.agentSessionMenu.refusedTurnMovesTo`) : t(`agents.agentSessionMenu.spendsSecondAccountOn`) }}
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
                <span class="text-sm text-content md:text-xs">{{ t(`agents.agentSessionMenu.archive`) }}</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? t(`agents.agentSessionMenu.waitAgentTurnTo`) : t(`agents.agentSessionMenu.branchDiffConversationKept`) }}
                </span>
            </span>
        </button>
        <button v-else type="button" :class="ITEM" :disabled="archiveBusy" @click="run(() => restore([agentId]))">
            <Icon name="history" class="mt-0.5 text-xs text-link" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-link md:text-xs">{{ t(`agents.agentSessionMenu.restore`) }}</span>
                <span class="text-2xs text-subtle">{{ t(`agents.agentSessionMenu.putsBackOnBoard`) }}</span>
            </span>
        </button>
        <button v-if="canShip" type="button" :class="ITEM" :disabled="changes.actionBusy.value || streaming" @click="run(() => emit(`discard`))">
            <Icon name="trash" class="mt-0.5 text-xs text-danger" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-danger md:text-xs">{{ t(`agents.agentSessionMenu.discard`) }}</span>
                <span class="text-2xs text-subtle">
                    {{ streaming ? t(`agents.agentSessionMenu.waitAgentTurnTo`) : t(`agents.agentSessionMenu.dropsAgentsBranchWorktree`) }}
                </span>
            </span>
        </button>
    </div>
</template>
