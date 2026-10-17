<script setup lang="ts">
import { Icon, SearchBar, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";
import { computed, nextTick, ref } from "vue";
import { agentDisplayTitle, agentStatusMeta } from "../../../../models/agent-status/agentStatus-meta";
import { useAgents } from "../../../../models/fleet/useAgents";
import { autoVersionRule, landsByDefault, NAMED_RULES } from "../../../../models/sandbox/environment/rules";
import { useRules } from "../../../../models/sandbox/environment/useRules";
import { useRole } from "../../../../client/sandbox/useRole";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import { type LandsHow, waitTargets } from "./waitTargets";
import { hourChoices, type SendLater, waitText } from "../../../../models/conversations/drafts/sendLater";
import LaterTimePicker from "./LaterTimePicker.vue";

/* When a message goes, when not now. HOUR FIRST: half a day of whole hours, one press each, since people book against
   the clock ("at 2, when the limit is back"). A day of its own, or a minute off the hour, is the advanced case, one
   row below and a view of its own (LaterTimePicker); waiting for another agent's work to land is the other row, and a
   view of its own too, so a long fleet never pushes the hours off the panel. The same panel is the send's caret in the
   composer (a pick there is the send) and re-times a message already waiting (ChatHeldBooking), so both read the same
   choices the same way. A pick is emitted and the host closes the panel; the one press that changes something else
   (letting the awaited agent land by itself) stays here. */

const t = useT();

const props = defineProps<{
    conversation: Conversation;
    // What is picked now, marked in the lists.
    picked?: SendLater | undefined;
    // The way to send now instead, shown while something is picked: "Send now" in both places.
    clearLabel?: string | undefined;
    // Open on the picker for a time of the reader's own rather than the hours: "Another day or time" in the quick pick.
    custom?: boolean;
}>();
const emit = defineEmits<{ pick: [later: SendLater]; clear: [] }>();

const now = useNow(() => true);
const hours = computed(() => hourChoices(now.value));
// Where the hours cross midnight, so the grid can say "Tomorrow" once, above the first of them.
const firstNextDay = computed(() => hours.value.findIndex((hour) => hour.nextDay));

// Which part of the panel shows: the hours, the picker for a time of the reader's own, or the agents to wait for.
type View = `hours` | `picker` | `agents`;
const view = ref<View>(props.custom === true ? `picker` : `hours`);
const pickerRow = ref<HTMLButtonElement>();
const agentsRow = ref<HTMLButtonElement>();
const backToHours = async (from: Exclude<View, `hours`>): Promise<void> => {
    view.value = `hours`;
    await nextTick();
    (from === `picker` ? pickerRow : agentsRow).value?.focus({ preventScroll: true });
};

const { fleet, setAutoLand } = useAgents();
const { byId, upsert, settings } = useRules();
const { canShip } = useRole();
const sandboxLands = computed(() => landsByDefault(settings.value?.rules ?? []));
const targets = computed(() => waitTargets(fleet.value, props.conversation.conversationId, sandboxLands.value));

// A long fleet gets a filter; a short one is read at a glance.
const FILTER_FROM = 7;
const filter = ref(``);
const shown = computed(() => {
    const needle = filter.value.trim().toLowerCase();
    return needle === `` ? targets.value : targets.value.filter(({ agent }) => agentDisplayTitle(agent).toLowerCase().includes(needle));
});

const landsWords = (lands: LandsHow): string => {
    switch (lands) {
        case `itself`:
            return t(`chat.sendLater.landsByItself`);
        case `you`:
            return t(`chat.sendLater.waitsForYou`);
        default:
            return t(`chat.sendLater.inWorkspace`);
    }
};

const pickedAfter = computed(() => (props.picked?.kind === `after` ? props.picked.conversationId : undefined));
const pickedAt = computed(() => (props.picked?.kind === `at` ? props.picked.at : undefined));
// A picked time no hour on the grid names: the reader's own, said on its row.
const pickedOwn = computed(() => pickedAt.value !== undefined && !hours.value.some((hour) => hour.at === pickedAt.value));
const pickedAgentTitle = computed(() => {
    const id = pickedAfter.value;
    const match = id === undefined ? undefined : targets.value.find(({ agent }) => agent.id === id);
    return match === undefined ? undefined : agentDisplayTitle(match.agent);
});

// An isolated agent starts from the last commit, so work another agent landed reaches it only once committed: said
// where the choice is made, with the one press that makes every land a commit, for a reader who may make it.
const uncommitted = computed(() => props.conversation.isolated.value && byId(NAMED_RULES.version)?.enabled !== true);
</script>

<template>
    <div class="flex max-h-[32rem] flex-col overflow-y-auto p-1">
        <LaterTimePicker
            v-if="view === `picker`"
            :now="now"
            :initial="pickedAt"
            @commit="emit(`pick`, { kind: `at`, at: $event })"
            @back="backToHours(`picker`)"
        />

        <!-- The agents a message can wait for, behind their row so the hours keep the top of the panel. -->
        <div v-else-if="view === `agents`" class="flex flex-col" @keydown.esc.stop.prevent="backToHours(`agents`)">
            <div class="flex items-center gap-1 px-1 pt-0.5 pb-1">
                <button
                    type="button"
                    class="composer-ghost h-7 w-7 shrink-0 max-md:h-10 max-md:w-10"
                    v-tooltip.top="t(`ui.action.back`)"
                    :aria-label="t(`ui.action.back`)"
                    @click="backToHours(`agents`)"
                >
                    <Icon name="chevron-left" class="text-xs" />
                </button>
                <p class="flex min-w-0 flex-col text-2xs">
                    <span class="truncate font-medium text-content">{{ t(`chat.sendLater.afterAgent`) }}</span>
                    <span class="truncate text-subtle">{{ t(`chat.sendLater.afterAgentNote`) }}</span>
                </p>
            </div>
            <SearchBar
                v-if="targets.length >= FILTER_FROM"
                v-model="filter"
                variant="field"
                dense
                clearable
                :placeholder="t(`chat.sendLater.filter`)"
                :aria-label="t(`chat.sendLater.filter`)"
                class="mx-2.5 mb-1"
            />
            <p v-if="targets.length === 0" class="px-2.5 py-1.5 text-2xs text-subtle">{{ t(`chat.sendLater.noAgents`) }}</p>
            <div
                v-for="{ agent, lands } in shown"
                :key="agent.id"
                class="ui-row-select flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 max-md:py-3"
                :class="{ 'ui-row-select-on': pickedAfter === agent.id }"
                role="button"
                tabindex="0"
                @click="emit(`pick`, { kind: `after`, conversationId: agent.id })"
                @keydown.enter.prevent="emit(`pick`, { kind: `after`, conversationId: agent.id })"
            >
                <Icon
                    :name="agentStatusMeta(agent.status).icon"
                    :spin="agentStatusMeta(agent.status).spin"
                    class="mt-0.5 shrink-0 text-xs"
                    :class="agentStatusMeta(agent.status).class"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ agentDisplayTitle(agent) }}</span>
                    <span class="truncate text-2xs text-subtle">{{ agentStatusMeta(agent.status).label }} · {{ landsWords(lands) }}</span>
                </span>
                <!-- Work that waits for a land would hold this message as long: the press that lets it land by itself is offered right on its row. -->
                <button
                    v-if="lands === `you` && canShip"
                    type="button"
                    class="composer-ghost h-6 shrink-0 gap-1 self-center px-2 text-2xs font-medium max-md:h-9"
                    v-tooltip.top="{ title: t(`chat.sendLater.alsoLandIt`), note: t(`chat.sendLater.alsoLandItNote`) }"
                    :aria-label="t(`chat.sendLater.alsoLandIt`)"
                    @click.stop="setAutoLand(agent.id, sandboxLands ? null : true)"
                    @keydown.enter.stop
                >
                    <Icon name="download" class="text-2xs text-link" />{{ t(`chat.sendLater.autoLand`) }}
                </button>
                <Icon v-if="pickedAfter === agent.id" name="check" class="mt-0.5 shrink-0 text-2xs text-accent" aria-hidden="true" />
            </div>
            <p v-if="targets.length > 0 && uncommitted" class="flex flex-col items-start gap-1 px-2.5 py-1.5 text-2xs text-subtle">
                <span>{{ t(`chat.sendLater.uncommitted`) }}</span>
                <button v-if="canShip" type="button" :class="ui.textButton({ tone: `quiet` })" @click="upsert(autoVersionRule())">
                    {{ t(`chat.sendLater.saveVersions`) }}
                </button>
            </p>
        </div>

        <template v-else>
            <p class="px-2.5 pt-1.5 pb-1 text-2xs font-medium text-subtle">{{ t(`chat.sendLater.sendAt`) }}</p>
            <!-- The hours, four to a row; where they cross midnight a caption says so once, and the next day starts its own row. -->
            <div class="grid grid-cols-4 gap-1 px-1 pb-1" role="group" :aria-label="t(`chat.sendLater.sendAt`)">
                <template v-for="(hour, index) in hours" :key="hour.at">
                    <p v-if="index === firstNextDay" class="col-span-4 px-1.5 pt-1.5 text-2xs font-medium text-subtle">
                        {{ t(`chat.sendLater.tomorrow`) }}
                    </p>
                    <button
                        type="button"
                        class="ui-row-select flex flex-col items-center rounded-lg px-1 py-1.5 max-md:py-2.5"
                        :class="{ 'ui-row-select-on': pickedAt === hour.at }"
                        :aria-label="formatUntil(hour.at, now)"
                        :aria-pressed="pickedAt === hour.at"
                        @click="emit(`pick`, { kind: `at`, at: hour.at })"
                    >
                        <span class="text-sm text-content tabular-nums md:text-xs">{{ formatClock(hour.at) }}</span>
                        <span class="text-3xs text-subtle tabular-nums">{{ waitText(hour.at, now) }}</span>
                    </button>
                </template>
            </div>

            <div class="mx-2.5 my-1 border-t border-line" aria-hidden="true" />
            <!-- A day of its own, or a minute off the hour: the picker, in the panel's place. Says the time while one is picked. -->
            <button
                ref="pickerRow"
                type="button"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': pickedOwn }"
                @click="view = `picker`"
            >
                <Icon name="calendar" class="shrink-0 text-xs text-subtle" />
                <span class="truncate text-sm text-content md:text-xs">{{ t(`chat.sendLater.pickTime`) }}</span>
                <span v-if="pickedOwn && pickedAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle tabular-nums">{{
                    formatUntil(pickedAt, now)
                }}</span>
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" :class="{ 'ml-auto': !pickedOwn }" aria-hidden="true" />
            </button>
            <!-- Work that builds on another agent's: the agents, in the panel's place. Names the one picked. -->
            <button
                ref="agentsRow"
                type="button"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': pickedAfter !== undefined }"
                @click="view = `agents`"
            >
                <Icon name="link" class="shrink-0 text-xs text-subtle" />
                <span class="truncate text-sm text-content md:text-xs">{{ t(`chat.sendLater.afterAgent`) }}</span>
                <span class="ml-auto max-w-28 shrink-0 truncate text-2xs text-subtle">{{
                    pickedAgentTitle ?? (targets.length > 0 ? targets.length : ``)
                }}</span>
                <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
            </button>

            <!-- The way back to sending now, while something is picked. -->
            <button
                v-if="picked !== undefined"
                type="button"
                class="ui-row-select mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="emit(`clear`)"
            >
                <Icon name="send" class="shrink-0 text-xs text-subtle" />
                <span class="text-sm text-content md:text-xs">{{ clearLabel ?? t(`chat.chatQueue.sendNow`) }}</span>
            </button>
        </template>
    </div>
</template>
