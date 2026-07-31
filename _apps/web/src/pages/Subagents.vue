<script setup lang="ts">
import type { RestoredMessage, SubagentSession } from "@intentic/sandbox-contract";
import { Icon, type IconName } from "@intentic-app/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { sandboxKey } from "../composables/sandbox/useSandbox";
import { subagentLive, useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { openWorkTerminal } from "../composables/terminal/useWorkTerminals";
import ChatToolCard from "../chat/ChatToolCard.vue";
import { renderMarkdown } from "../composables/renderMarkdown";

/* THE AGENTS THIS SANDBOX'S AGENTS STARTED — the third surface of the same kind, after the terminal panel and the
 * Browsers area. A turn's shell and its browser were already things the operator could open and look at; the
 * agents it starts were not, which is the one of the three that is itself an agent and the one most likely to be
 * doing something you would want to see.
 *
 * WHY IT IS A ROUTE AND NOT A PANE. A subagent has no byte stream and no live page: the thing you watch it
 * through is its TRANSCRIPT, which wants a column, not a strip. So the shape is the Browsers area's — a list down
 * the left answering "which agent?", the selected one's work filling the rest — and the content is the chat's own,
 * rendered by the very components the conversation uses (ChatToolCard), because a child's work should read exactly
 * like its parent's.
 *
 * TWO KINDS IN ONE LIST, deliberately: an Agent/Task subagent and a `codex exec` the agent drove from its own
 * shell are the same fact from out here — another agent, working, that you did not start. What differs is only
 * how you watch it live, and a delegation says so by offering its terminal. */

const LIST_POLL_MS = 3000;
// The transcript is re-read on a slower beat than the roster: a running child's frames arrive in bursts, and the
// list above is what answers "is it still going" between them.
const TRANSCRIPT_POLL_MS = 4000;

const route = useRoute();
const router = useRouter();
const { sessions } = useSubagentsQuery(LIST_POLL_MS);
const { agentById } = useAgents();

// The subagent in the URL, so a reload (or the card's link) opens the same one. Falls back to the first listed —
// which the daemon sorts live-first, so landing here with no id shows what is happening now.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`id`] === `string` ? route.params[`id`] : undefined;
    if (named !== undefined && sessions.value.some((session) => session.id === named)) {
        return named;
    }
    return sessions.value[0]?.id;
});
const current = computed(() => sessions.value.find((session) => session.id === selected.value));

const select = (id: string): void => void router.push(`/subagents/${id}`);

// Running first, then what has finished — the two questions this list is opened with, in that order.
const lanes = computed<{ readonly label: string; readonly rows: SubagentSession[] }[]>(() => [
    { label: `Running`, rows: sessions.value.filter(subagentLive) },
    { label: `Finished`, rows: sessions.value.filter((session) => !subagentLive(session)) },
]);

// The row's heading: what it runs as, then what it was asked to do. Same ladder the chat card uses, so a row and
// the card it came from read as the same agent.
const titleOf = (session: SubagentSession): string =>
    [session.agentType, session.description].filter(Boolean).join(` · `) || `Agent ${session.id.slice(-6)}`;
// Which agent's turn started it — the way back to the conversation this all came out of.
const parentOf = (session: SubagentSession): string | undefined => agentById(session.conversationId)?.title ?? undefined;

const STATUS: Record<SubagentSession["status"], { readonly icon: IconName; readonly class: string }> = {
    pending: { icon: `clock`, class: `text-subtle` },
    running: { icon: `spinner`, class: `text-link` },
    paused: { icon: `clock`, class: `text-warning` },
    completed: { icon: `check`, class: `text-success` },
    failed: { icon: `times`, class: `text-danger` },
    killed: { icon: `stop`, class: `text-subtle` },
};

// The quiet numbers on a row: what it spent, what it did, and when it was last heard from.
const factsOf = (session: SubagentSession): string[] => [
    ...(subagentLive(session) && session.lastTool !== undefined ? [session.lastTool] : []),
    ...(session.toolUses !== undefined && session.toolUses > 0 ? [`${session.toolUses} tools`] : []),
    ...(session.tokens !== undefined && session.tokens > 0 ? [`${Math.round(session.tokens / 1000)}k tokens`] : []),
    ...(session.activityAt > 0 ? [relativeTime(session.activityAt)] : []),
];

/* THE SELECTED CHILD'S TRANSCRIPT. Polled while it runs and read once when it has finished — the daemon serves a
 * live one out of its parent turn's frame log and a settled one out of whichever store ran it, so this side needs
 * to know neither (see sessions/subagent-transcript.ts). */
const transcript = useQuery({
    queryKey: computed(() => sandboxKey(`subagent-transcript`, selected.value ?? ``)),
    enabled: computed(() => selected.value !== undefined),
    refetchInterval: computed(() => (current.value !== undefined && subagentLive(current.value) ? TRANSCRIPT_POLL_MS : false)),
    queryFn: async (): Promise<RestoredMessage[]> => {
        const id = selected.value;
        if (id === undefined) {
            return [];
        }
        const body = (await sandboxJson(`/system/subagents/${encodeURIComponent(id)}/transcript`)) as { messages?: RestoredMessage[] };
        return body.messages ?? [];
    },
});
const messages = computed<RestoredMessage[]>(() => transcript.data.value ?? []);

// The transcript pane scrolls itself to the bottom as a running child writes — the same expectation the chat sets.
const pane = ref<HTMLElement | undefined>();
watch(messages, () => {
    requestAnimationFrame(() => {
        const el = pane.value;
        if (el !== undefined) {
            el.scrollTop = el.scrollHeight;
        }
    });
});
</script>

<template>
    <div class="flex h-full min-h-0">
        <!-- Nothing has delegated yet. Not an error — plenty of turns never start an agent — so this describes
             the surface instead of reporting a fault, the way the Browsers area's empty state does. -->
        <div v-if="sessions.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="users" class="text-2xl text-muted" />
            <div class="text-sm text-content">No agents started</div>
            <div class="max-w-sm text-xs text-muted">
                When an agent delegates — with its Agent tool, or by driving Codex or Grok from its shell — the agent it started appears here, with
                its own transcript.
            </div>
        </div>

        <template v-else>
            <!-- WHICH AGENT. A rail rather than a pill row: a row of pills can hold a name, and what a row here
                 has to hold is a name, a parent, a status and a spend. -->
            <aside class="scrollbar-thin flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-1.5">
                <template v-for="lane in lanes" :key="lane.label">
                    <template v-if="lane.rows.length > 0">
                        <div class="mt-2 px-1 text-2xs font-semibold uppercase tracking-wide text-subtle first:mt-0">
                            {{ lane.label }} <span class="font-normal">{{ lane.rows.length }}</span>
                        </div>
                        <button
                            v-for="session in lane.rows"
                            :key="session.id"
                            type="button"
                            class="flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5 text-left text-2xs transition-colors"
                            :class="
                                session.id === selected
                                    ? 'border-primary-500 bg-overlay text-content'
                                    : 'border-line text-muted hover:border-line-strong hover:text-content'
                            "
                            @click="select(session.id)"
                        >
                            <span class="flex w-full min-w-0 items-start gap-1.5">
                                <Icon
                                    :name="STATUS[session.status].icon"
                                    :spin="session.status === 'running'"
                                    :class="STATUS[session.status].class"
                                    class="mt-px shrink-0 text-2xs"
                                    :aria-label="session.status"
                                />
                                <span class="line-clamp-2 min-w-0 flex-1 font-medium leading-4">{{ titleOf(session) }}</span>
                                <!-- Backgrounded: the parent went on working instead of waiting. The fact that
                                     explains a child still running under a turn that looks finished. -->
                                <span v-if="session.background === true && subagentLive(session)" class="shrink-0 text-subtle">bg</span>
                            </span>
                            <span v-if="parentOf(session)" class="flex w-full min-w-0 items-center gap-1 text-subtle">
                                <Icon name="comments" class="shrink-0 text-2xs" />
                                <span class="truncate">{{ parentOf(session) }}</span>
                            </span>
                            <span v-if="factsOf(session).length > 0" class="flex w-full flex-wrap items-center gap-x-2 tabular-nums text-subtle">
                                <span v-for="fact in factsOf(session)" :key="fact">{{ fact }}</span>
                            </span>
                        </button>
                    </template>
                </template>
            </aside>

            <div class="flex min-w-0 flex-1 flex-col">
                <!-- WHAT IT IS, and the two ways out of this pane: back to the conversation that started it, and —
                     for a delegation, which unlike a subagent has a process of its own — into the shell it runs in. -->
                <div v-if="current" class="flex shrink-0 items-center gap-2 border-b border-line bg-card px-2 py-1 text-2xs text-muted">
                    <Icon
                        :name="STATUS[current.status].icon"
                        :spin="current.status === 'running'"
                        :class="STATUS[current.status].class"
                        class="shrink-0 text-2xs"
                    />
                    <span class="min-w-0 truncate text-content">{{ titleOf(current) }}</span>
                    <span v-if="current.model" class="shrink-0">{{ current.model }}</span>
                    <span class="ml-auto flex shrink-0 items-center gap-2">
                        <button
                            v-if="current.terminal"
                            type="button"
                            class="rounded border border-line px-1.5 py-0.5 transition-colors hover:text-content"
                            title="Watch the shell this agent runs in"
                            @click="openWorkTerminal(current.terminal)"
                        >
                            Terminal
                        </button>
                        <RouterLink
                            :to="`/agents/${current.conversationId}`"
                            class="rounded border border-line px-1.5 py-0.5 transition-colors hover:text-content"
                            title="Open the conversation that started this agent"
                        >
                            Parent
                        </RouterLink>
                    </span>
                </div>
                <!-- Its report, above its work — the answer is what the delegation was for. -->
                <p
                    v-if="current?.summary"
                    class="shrink-0 whitespace-pre-wrap border-b border-line px-3 py-2 text-2xs leading-relaxed"
                    :class="current.error ? 'text-danger' : 'text-muted'"
                >
                    {{ current.summary }}
                </p>

                <!-- ITS WORK, in the chat's own shapes: prose as prose, tool calls as the very cards the
                     conversation draws (children and all — a child that itself delegates nests here too). -->
                <div ref="pane" class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
                    <div v-for="(message, index) in messages" :key="index" class="flex flex-col gap-1">
                        <!-- The prompt it was given reads as a prompt: the same right-aligned bubble the chat
                             gives the user's own words, because from the child's side that is what it is. -->
                        <p
                            v-if="message.role === 'user'"
                            class="self-end whitespace-pre-wrap rounded-lg bg-overlay px-2.5 py-1.5 text-xs leading-relaxed text-content"
                        >
                            {{ message.text }}
                        </p>
                        <template v-else>
                            <div v-if="message.thinking" class="text-2xs italic leading-relaxed text-subtle">{{ message.thinking }}</div>
                            <!-- eslint-disable-next-line vue/no-v-html -- same sanitized renderer the chat's own prose goes through -->
                            <div
                                v-if="message.text"
                                class="chat-markdown text-xs leading-relaxed text-content"
                                v-html="renderMarkdown(message.text)"
                            ></div>
                            <ChatToolCard
                                v-for="tool in message.tools ?? []"
                                :key="tool.id"
                                :tool="tool"
                                :live="current !== undefined && subagentLive(current)"
                            />
                        </template>
                    </div>
                    <p v-if="messages.length === 0" class="px-1 py-3 text-center text-2xs text-subtle">
                        {{ current !== undefined && subagentLive(current) ? "Nothing recorded yet." : "No transcript was recorded for this agent." }}
                    </p>
                </div>
            </div>
        </template>
    </div>
</template>
