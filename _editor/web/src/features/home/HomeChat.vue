<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { agentTabOf, reveal } from "../../models/conversations/panel/useChat-reveal";
import { Conversation } from "../../models/conversations/session/conversation";
import { registry } from "../../models/fleet/useAgents-registry";
import { workLedger } from "../../models/home/homeFacts";
import ChatPane from "../chat/panel/ChatPane.vue";
import HomeChatSlot from "./HomeChatSlot.vue";
import { useDevice } from "@intentic/ui";

const t = useT();
const sandbox = useSandbox();
const { mobile } = useDevice();
const conversation = shallowRef<Conversation>();
const failure = shallowRef(false);
const now = useNow(() => true);
const retry = shallowRef(0);
const ledger = computed(() => (conversation.value === undefined ? [] : workLedger(registry.value, conversation.value.conversationId, now.value)));
watch(
    () => [sandbox.activeSandboxId.value, sandbox.reachable.value, retry.value] as const,
    async ([id, reachable], _old, cleanup) => {
        let current = true;
        cleanup(() => {
            current = false;
        });
        failure.value = false;
        if (id === undefined || !reachable) {
            return;
        }
        try {
            const home = await sandboxRpc.agents.home(undefined, { context: { at: id, background: true } });
            if (!current) {
                return;
            }
            const entry = home.agent === undefined ? new Conversation(home.conversationId) : { ...agentTabOf(home.agent), isolated: true };
            const opened = reveal({ verb: `show`, entries: [entry], focus: home.conversationId, caret: false });
            if (opened !== undefined) {
                opened.isolated.value = true;
                // Named before its first turn, so its draft card and the conversation that turn opens read as the home.
                opened.title.value ??= t(`home.title`);
                conversation.value = opened;
            }
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
    <section class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
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
        <p v-else class="p-6 text-sm text-muted" role="status">
            {{ !sandbox.reachable.value ? t(`home.offline`) : failure ? t(`home.failed`) : t(`home.loading`) }}
            <button v-if="failure" type="button" class="ml-3 underline" @click="retry++">{{ t(`home.retry`) }}</button>
        </p>
    </section>
</template>
