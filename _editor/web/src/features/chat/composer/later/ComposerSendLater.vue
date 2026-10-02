<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { agentDisplayTitle, agentStatusMeta } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { autoVersionRule, landsByDefault, NAMED_RULES } from "../../../sandbox/environment/rules";
import { useRules } from "../../../sandbox/environment/useRules";
import { useRole } from "../../../sandbox/secrets/useRole";
import type { Conversation } from "../../session/conversation";
import { type LandsHow, waitTargets } from "./waitTargets";
import { bookable, instantOfInput, LATEST_SEND_MS, localInputOf, type SendLater, SOONEST_SEND_MS, sendTimeLabel, timeChoices } from "./sendLater";

/* When a message goes, when not now: one of a few times, a time of the reader's own, or once another agent's work has
   landed in the workspace, for work that builds on it. The same panel books the composer's next message and re-times
   one already waiting (ChatHeldMessages), so both read the same choices the same way. A pick is emitted and the host
   closes the panel; the one press that changes something else (letting the awaited agent land by itself) stays here. */

const t = useT();

const props = defineProps<{
    conversation: Conversation;
    // What is picked now, marked in the lists.
    picked?: SendLater | undefined;
    // The way back to sending now: "Send now instead" in the composer, "Send now" for a message already waiting.
    clearLabel?: string | undefined;
}>();
const emit = defineEmits<{ pick: [later: SendLater]; clear: [] }>();

const now = useNow(() => true);
const choices = computed(() => timeChoices(now.value));

// The reader's own time, in the field the browser offers for it, bounded to what the sandbox keeps.
const custom = ref(props.picked?.kind === `at` ? localInputOf(props.picked.at) : ``);
const customAt = computed(() => instantOfInput(custom.value));
const customOk = computed(() => customAt.value !== undefined && bookable(customAt.value, now.value));
const customTouched = ref(false);
const setCustom = (): void => {
    customTouched.value = true;
    if (customAt.value !== undefined && customOk.value) {
        emit(`pick`, { kind: `at`, at: customAt.value });
    }
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

// An isolated agent starts from the last commit, so work another agent landed reaches it only once committed: said
// where the choice is made, with the one press that makes every land a commit, for a reader who may make it.
const uncommitted = computed(() => props.conversation.isolated.value && byId(NAMED_RULES.version)?.enabled !== true);
</script>

<template>
    <div class="flex max-h-[32rem] flex-col overflow-y-auto p-1">
        <p class="px-2.5 pt-1.5 pb-1 text-2xs font-medium text-subtle">{{ t(`chat.sendLater.atTime`) }}</p>
        <button
            v-for="choice in choices"
            :key="choice.key"
            type="button"
            class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': pickedAt === choice.at }"
            @click="emit(`pick`, { kind: `at`, at: choice.at })"
        >
            <Icon name="clock" class="shrink-0 text-xs text-subtle" />
            <span class="truncate text-sm text-content md:text-xs">{{ choice.label }}</span>
            <span class="ml-auto shrink-0 text-2xs text-subtle tabular-nums">{{ sendTimeLabel(choice.at, now) }}</span>
        </button>
        <!-- The reader's own time: the browser's field, kept to what the sandbox will hold, set by its own press so a half-typed date never books. -->
        <form class="flex flex-col gap-1 px-2.5 py-1.5" @submit.prevent="setCustom()">
            <label class="text-2xs text-subtle" for="send-later-at">{{ t(`chat.sendLater.pickTime`) }}</label>
            <span class="flex items-center gap-1.5">
                <input
                    id="send-later-at"
                    v-model="custom"
                    type="datetime-local"
                    :min="localInputOf(now + SOONEST_SEND_MS)"
                    :max="localInputOf(now + LATEST_SEND_MS)"
                    :class="[ui.inputSm(), `min-w-0 flex-1`, customTouched && !customOk ? `ui-field-error-box` : ``]"
                />
                <button type="submit" class="composer-ghost h-7 shrink-0 px-2.5 text-2xs font-medium" :disabled="customAt === undefined">
                    {{ t(`chat.sendLater.setTime`) }}
                </button>
            </span>
            <span v-if="customTouched && !customOk" class="text-2xs text-warning">{{ t(`chat.sendLater.outOfRange`) }}</span>
        </form>

        <!-- The heading teaches what the second half is for: work that needs another agent's to be in first. -->
        <p class="flex flex-col px-2.5 pt-2.5 pb-1 text-2xs">
            <span class="font-medium text-subtle">{{ t(`chat.sendLater.afterAgent`) }}</span>
            <span class="text-subtle">{{ t(`chat.sendLater.afterAgentNote`) }}</span>
        </p>
        <input
            v-if="targets.length >= FILTER_FROM"
            v-model="filter"
            type="search"
            :placeholder="t(`chat.sendLater.filter`)"
            :aria-label="t(`chat.sendLater.filter`)"
            :class="[ui.inputSm(), `mx-2.5 mb-1`]"
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
                class="composer-ghost h-6 shrink-0 gap-1 self-center px-2 text-2xs font-medium"
                v-tooltip.top="{ title: t(`chat.sendLater.alsoLandIt`), note: t(`chat.sendLater.alsoLandItNote`) }"
                :aria-label="t(`chat.sendLater.alsoLandIt`)"
                @click.stop="setAutoLand(agent.id, sandboxLands ? null : true)"
                @keydown.enter.stop
            >
                <Icon name="download" class="text-2xs text-link" />{{ t(`chat.sendLater.autoLand`) }}
            </button>
            <Icon v-if="pickedAfter === agent.id" name="check" class="mt-0.5 shrink-0 text-2xs text-primary-500" aria-hidden="true" />
        </div>
        <p v-if="targets.length > 0 && uncommitted" class="flex flex-col items-start gap-1 px-2.5 py-1.5 text-2xs text-subtle">
            <span>{{ t(`chat.sendLater.uncommitted`) }}</span>
            <button v-if="canShip" type="button" :class="ui.textAction()" @click="upsert(autoVersionRule())">{{ t(`chat.sendLater.saveVersions`) }}</button>
        </p>

        <!-- The way back to an ordinary send, a row in this list as the run-through menu's is. -->
        <button
            v-if="picked !== undefined"
            type="button"
            class="ui-row-select mt-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`clear`)"
        >
            <Icon name="send" class="shrink-0 text-xs text-subtle" />
            <span class="text-sm text-content md:text-xs">{{ clearLabel ?? t(`chat.sendLater.clear`) }}</span>
        </button>
    </div>
</template>
