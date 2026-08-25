<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { useRunners } from "../composables/sandbox/useRunners";

/* WHERE THIS CONVERSATION RUNS: here, or on one of this sandbox's runners (a container of its own on another
 * machine, docs/remote-runners-plan.md in the workspace). The turn behaves the same either way, same tools,
 * same review, same land; what moves is whose CPU and memory it spends.
 *
 * OFFERED ONLY BEFORE THE FIRST TURN. Placement is part of a conversation's identity: the daemon latches it
 * with the branch on the first turn and every turn after follows the conversation, because a conversation
 * cannot be halfway between two machines. So once it has run, this reads rather than asks, and the way to
 * work somewhere else is a new agent, which is one click away.
 *
 * An OFFLINE runner is listed but not selectable: it is still paired (its machine is asleep, or its container
 * is down), and offering it would only produce a turn that comes back saying to go wake it. */

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

const { runners } = useRunners();
const picked = computed(() => conversation.runner.value);
// The board has known this conversation ⇒ its placement is settled (Conversation.registered latches on the
// first roster frame). A draft is the whole window in which this control means anything.
const settled = computed(() => conversation.registered.value);

/* What the row says under the name. An OUTDATED runner is still offered, and says so: it runs turns, it is
 * simply behind this sandbox's build, and the choice between "run it there now" and "update it first" is the
 * user's (the Computers view has the button). */
const detail = (runner: { online: boolean; parity: string; facts?: { cpus: number; load: number } }): string => {
    if (!runner.online) {
        return `Offline — wake that machine to use it`;
    }
    const load = runner.facts === undefined ? `Ready` : `${runner.facts.cpus} cores · load ${runner.facts.load.toFixed(2)}`;
    return runner.parity === `outdated` ? `${load} · older build than this sandbox` : load;
};

const place = (id: string | undefined): void => {
    if (settled.value) {
        return;
    }
    conversation.runner.value = id;
    emit(`selected`);
};
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': picked === undefined }"
            :disabled="settled"
            @click="place(undefined)"
        >
            <Icon name="box" class="mt-0.5 text-xs" :class="picked === undefined ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">This sandbox</span>
                <span class="text-2xs text-subtle">Runs on the machine this workspace lives on.</span>
            </span>
        </button>
        <button
            v-for="runner in runners"
            :key="runner.id"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': picked === runner.id }"
            :disabled="settled || !runner.online"
            @click="place(runner.id)"
        >
            <Icon name="desktop" class="mt-0.5 text-xs" :class="picked === runner.id ? 'text-primary-500' : 'text-subtle'" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">{{ runner.id }}</span>
                <span class="text-2xs text-subtle">{{ detail(runner) }}</span>
            </span>
        </button>
        <p v-if="runners.length === 0" class="px-2.5 py-1.5 text-2xs text-subtle">
            No runners yet. Add one on a connected computer under Sandbox ▸ Computers to run agents there.
        </p>
        <p v-else-if="settled" class="px-2.5 py-1.5 text-2xs text-subtle">
            This conversation already runs {{ picked === undefined ? `here` : `on “${picked}”` }}. Start a new agent to work somewhere else.
        </p>
    </div>
</template>
