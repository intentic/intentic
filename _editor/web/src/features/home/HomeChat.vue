<script setup lang="ts">
import { computed, onUnmounted, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import type { Conversation } from "../../models/conversations/session/conversation";
import { homeConversation, homeConversationFor, homeShownFor } from "../../models/home/homeChat";
import { registry } from "../../models/fleet/useAgents-registry";
import { workLedger } from "../../models/home/homeFacts";
import ChatPane from "../chat/panel/ChatPane.vue";
import HomeChatSlot from "./HomeChatSlot.vue";
import { Button, useDevice } from "@intentic/ui";
import { useRole } from "../../client/sandbox/useRole";
import { invalidateAgentAction, landAgent, nothingLanded } from "../../models/fleet/agentActions";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import HomeNoSandbox from "./HomeNoSandbox.vue";
import HomeSandboxBar from "./HomeSandboxBar.vue";
import { useWorkspaceTree } from "../../models/workspace/tree/useWorkspaceTree";
import { useSandboxAvailability } from "../sandbox/overview/useSandboxAvailability";

const t = useT();
const sandbox = useSandbox();
const noSandbox = computed(() => switchableSandboxes(sandbox.sandboxes.value).length === 0);
const { mobile } = useDevice();
const conversation = shallowRef<Conversation>();
const failure = shallowRef(false);
const now = useNow(() => true);
const retry = shallowRef(0);
// The panel the page lends draws exactly this one (models/home/homeChat.ts), and the sandbox it belongs to is said to be
// on screen, which is what the Add sandbox dialog opened from here waits on.
watch(
    conversation,
    (open) => {
        homeConversation.value = open;
        homeShownFor.value = open === undefined ? undefined : sandbox.activeSandboxId.value;
    },
    { immediate: true },
);
onUnmounted(() => {
    homeConversation.value = undefined;
    homeShownFor.value = undefined;
});
// While the sandbox is not answering: on its way up (a machine waking, a container starting) or not, which the bar's
// Open explains in full (the sandbox's own gate) rather than this line.
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const comingUp = computed(() => [`starting`, `warming`, `busy`].includes(availability.value));
const ledger = computed(() => (conversation.value === undefined ? [] : workLedger(registry.value, conversation.value.conversationId, now.value)));
// What the home holds back: its work, when a landing rule kept it or its person may not land (`ready`), or a clash with
// the workspace (`conflict`). Who may press Land is who the home lands for (useRole `canLandHome`), the same answer the
// daemon gives its own land, so the person and the agent working for them never differ on it.
const { canLandHome } = useRole();
const homeCard = computed(() => registry.value.find((agent) => agent.id === conversation.value?.conversationId));
const held = computed(() => homeCard.value?.status === `ready` || homeCard.value?.status === `conflict`);
const landing = shallowRef(false);
const landNote = shallowRef<string>();
const land = async (): Promise<void> => {
    const id = conversation.value?.conversationId;
    if (id === undefined || landing.value) {
        return;
    }
    landing.value = true;
    landNote.value = undefined;
    try {
        const result = await landAgent(id);
        await invalidateAgentAction(id);
        landNote.value = !result.landed ? t(`home.landConflict`) : result.changed ? undefined : nothingLanded();
    } catch {
        landNote.value = t(`home.landFailed`);
    } finally {
        landing.value = false;
    }
};
watch(
    () => [sandbox.activeSandboxId.value, sandbox.reachable.value, noSandbox.value, retry.value] as const,
    async ([id, reachable, empty], _old, cleanup) => {
        let current = true;
        cleanup(() => {
            current = false;
        });
        failure.value = false;
        if (empty || id === undefined || !reachable) {
            if (empty) {
                conversation.value = undefined;
            }
            return;
        }
        // Another sandbox's home is not this one's: nothing is said to be on screen until this one's is.
        if (homeShownFor.value !== id) {
            homeShownFor.value = undefined;
        }
        try {
            const home = await sandboxRpc.agents.home(undefined, { context: { at: id, background: true } });
            if (!current) {
                return;
            }
            conversation.value = homeConversationFor(id, home, t(`home.title`));
        } catch {
            if (current) {
                failure.value = true;
            }
        }
    },
    { immediate: true },
);
</script>

<template>
    <HomeNoSandbox v-if="noSandbox" />
    <section v-else class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <HomeSandboxBar :phone="mobile" />
        <details v-if="ledger.length" class="shrink-0 border-b border-line px-4 py-2 text-xs" open>
            <summary class="cursor-pointer text-muted">{{ t(`home.work`) }} · {{ ledger.length }}</summary>
            <div class="max-h-40 overflow-auto py-1">
                <div v-for="row in ledger" :key="row.worker.id" class="py-1">
                    <RouterLink :to="`/agents/${encodeURIComponent(row.worker.id)}`" class="flex items-center gap-3 hover:text-link">
                        <span class="min-w-0 flex-1 truncate">{{ row.worker.title ?? row.worker.id }}</span>
                        <span class="text-muted">{{ t(`home.stage.${row.stage}`) }}</span>
                    </RouterLink>
                    <p v-if="row.subject" class="truncate text-muted">{{ row.subject }}</p>
                    <RouterLink
                        v-for="check in row.checks"
                        :key="check.id"
                        :to="`/agents/${encodeURIComponent(check.id)}`"
                        class="ml-3 block truncate py-0.5 text-muted hover:text-link"
                        >{{ check.title ?? t(`home.stage.${check.fresh?.kind === "test" ? "testing" : "reviewing"}`) }}</RouterLink
                    >
                </div>
            </div>
        </details>
        <div v-if="held" class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-xs" role="status">
            <span class="min-w-0 flex-1 text-muted">{{
                homeCard?.status === `conflict` ? t(`home.heldConflict`) : canLandHome ? t(`home.heldForYou`) : t(`home.heldForMaintainer`)
            }}</span>
            <Button v-if="canLandHome && homeCard?.status === `ready`" :label="t(`home.land`)" size="small" :loading="landing" @click="land" />
        </div>
        <p v-if="landNote" class="shrink-0 border-b border-line px-4 py-2 text-xs text-muted" role="status">{{ landNote }}</p>
        <!-- A desktop lends the shell's chat panel this page (HomeChatSlot.vue); a phone, with no panel above its router,
             draws the pane itself on the chat's own surface. -->
        <HomeChatSlot v-if="conversation && !mobile" :key="`${sandbox.activeSandboxId.value}:${conversation.conversationId}`" />
        <div v-else-if="conversation" class="ground-card flex min-h-0 flex-1 bg-card">
            <ChatPane
                :key="`${sandbox.activeSandboxId.value}:${conversation.conversationId}`"
                :conversation="conversation"
                :focused="true"
                :closable="false"
            />
        </div>
        <div v-else class="flex flex-1 items-start justify-center p-6">
            <p v-if="!sandbox.reachable.value && comingUp" class="flex items-center gap-2 text-sm text-muted" role="status">
                <Icon name="spinner" spin class="text-xs text-info" aria-hidden="true" />
                {{ t(`home.starting`, { name: sandbox.active.value?.name ?? `` }) }}
            </p>
            <div v-else-if="!sandbox.reachable.value" class="flex max-w-md flex-col gap-1 text-sm" role="status">
                <p class="text-content">{{ t(`home.offline`) }}</p>
                <p class="text-muted">{{ t(`home.offlineHint`) }}</p>
            </div>
            <p v-else class="text-sm text-muted" role="status">
                {{ failure ? t(`home.failed`) : t(`home.loading`) }}
                <button v-if="failure" type="button" class="ml-3 underline" @click="retry++">{{ t(`home.retry`) }}</button>
            </p>
        </div>
    </section>
</template>
