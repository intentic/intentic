<script setup lang="ts">
import type { AgentProvider, RestoredMessage, SubagentSession } from "@intentic/sandbox-contract";
import { formatTokens, Icon, type IconName } from "@intentic/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activityIcon } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { sandboxKey } from "../composables/sandbox/useSandbox";
import { subagentLive, useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { openWorkTerminal } from "../composables/terminal/useWorkTerminals";
import ChatToolCard from "../chat/ChatToolCard.vue";
import IdentityTile from "../components/IdentityTile.vue";
import RailCard from "../components/RailCard.vue";
import RailLane from "../components/RailLane.vue";
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
 * THE LIST IS THE CHAT RAIL'S, NOT A SECOND LIST OF SESSIONS. Its rows are RailCard on RailLane — the same card
 * and the same lane slab the popped-out chat lists its conversations with, and the fleet board's card one column
 * wide. This used to be its own thing: a flat column of bordered rows, its own status glyphs, its own facts in
 * its own order, no identity tile and no card surface — so the agents an AGENT started looked like a different
 * kind of object from the agents the user started, two screens apart in the same app. Everything a row needs
 * beyond the shared card is a fact about delegation and only that: which turn started it, that it was
 * backgrounded, and — for a delegation — the shell it runs in.
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

/* ONE AGENT'S CHILDREN, when the card's chip is what opened this. The chip is a fact about ONE agent — "this
 * one started five" — and following it into a list of everything every agent in the sandbox has spawned makes
 * the reader do the filtering the click already expressed. Carried as a query rather than a route of its own so
 * the id in the path keeps meaning the selected child, and so "show all" is a link that drops one parameter. */
const focus = computed<string | undefined>(() => (typeof route.query[`agent`] === `string` ? route.query[`agent`] : undefined));
const focusTitle = computed(() => (focus.value === undefined ? undefined : (agentById(focus.value)?.title ?? `this agent`)));
const visible = computed(() =>
    focus.value === undefined ? sessions.value : sessions.value.filter((session) => session.conversationId === focus.value),
);

// The subagent in the URL, so a reload (or the card's link) opens the same one. Falls back to the first listed —
// which the daemon sorts live-first, so landing here with no id shows what is happening now.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`id`] === `string` ? route.params[`id`] : undefined;
    if (named !== undefined && visible.value.some((session) => session.id === named)) {
        return named;
    }
    return visible.value[0]?.id;
});
const current = computed(() => visible.value.find((session) => session.id === selected.value));

// Selecting keeps whatever narrowed the list — a click inside a filtered rail must not silently widen it.
const select = (id: string): void => void router.push({ name: `subagents`, params: { id }, query: route.query });

// Running first, then what has finished — the two questions this list is opened with, in that order. The dots
// are the board's own (ChatTabList's LANES): live is success, the terminal shelf is neutral.
const lanes = computed<{ readonly label: string; readonly dot: string; readonly rows: SubagentSession[] }[]>(() => [
    { label: `Running`, dot: `bg-success`, rows: visible.value.filter(subagentLive) },
    { label: `Finished`, dot: `bg-line-strong`, rows: visible.value.filter((session) => !subagentLive(session)) },
]);

/* The row's heading: WHAT IT WAS ASKED TO DO. The card's one piece of content, so the description takes it
 * whole — the type it runs as (`Explore`, `general-purpose`) is a fact ABOUT the row and rides the meta line
 * with the rest of them. It used to lead the title, where on a rail this wide it ate the half of the line that
 * says which of fourteen children this one is: every row began "general-purpose · " and the descriptions were
 * clipped at the point they started to differ. */
const titleOf = (session: SubagentSession): string =>
    [session.description, session.agentType].find((part) => part !== undefined && part !== ``) ?? `Agent ${session.id.slice(-6)}`;
// Which agent's turn started it — the way back to the conversation this all came out of.
const parentOf = (session: SubagentSession): string | undefined => agentById(session.conversationId)?.title ?? undefined;

/* WHO IS ACTUALLY RUNNING IT, for the identity tile's fallback mark — and for a delegation that is the row's
 * whole point: a `codex exec` the agent drove from its shell is another vendor's agent working in this sandbox,
 * and a row that doesn't say so reads as one of ours. An SDK subagent runs inside its parent's own turn, so it
 * wears the parent's provider, falling back to Claude once the roster no longer holds the parent. */
const providerOf = (session: SubagentSession): AgentProvider =>
    session.kind === `subagent` ? (agentById(session.conversationId)?.provider ?? `claude`) : session.kind;

// The SDK's own task vocabulary, ready to `v-bind` onto the Icon — the shape agentStatusMeta returns for a
// fleet agent, so the rail's glyph slot is fed the same way here as it is there.
const STATUS: Record<SubagentSession["status"], { name: IconName; spin?: boolean; class: string; "aria-label": string }> = {
    pending: { name: `clock`, class: `text-xs text-subtle`, "aria-label": `Queued` },
    running: { name: `spinner`, spin: true, class: `text-xs text-link`, "aria-label": `Running` },
    paused: { name: `clock`, class: `text-xs text-warning`, "aria-label": `Paused` },
    completed: { name: `check`, class: `text-xs text-success`, "aria-label": `Completed` },
    failed: { name: `times`, class: `text-xs text-danger`, "aria-label": `Failed` },
    killed: { name: `stop`, class: `text-xs text-subtle`, "aria-label": `Killed` },
};

/* THE LIVE LINE, the board's own: what it is doing this second and how long it has been at it, in link — the
 * one accent that makes a working row findable in a column of stopped ones. A PENDING child gets one too, and
 * it is the most useful reading on this surface: a queued agent is one the concurrency cap has not let start,
 * and "Queued · 40s" is the difference between a cap doing its job and a child that is never going to run. */
const liveOf = (session: SubagentSession): { icon: IconName; text: string; since: number } | undefined => {
    if (!subagentLive(session)) {
        return undefined;
    }
    if (session.status === `pending`) {
        return { icon: `clock`, text: `Queued`, since: session.startedAt };
    }
    return { icon: activityIcon(session.lastTool), text: session.lastTool ?? `Working…`, since: session.startedAt };
};

/* HAS THE ROW'S FACTS LINE ANYTHING TO SAY? Asked for the same reason the chat rail's card asks it: a slot
 * handed a `v-if`-ed template still hands back a vnode, so an unguarded line draws an empty strip under the
 * title on a child the daemon has only just heard of. */
const hasFacts = (session: SubagentSession): boolean =>
    (session.background === true && subagentLive(session)) ||
    (focus.value === undefined && parentOf(session) !== undefined) ||
    session.agentType !== undefined ||
    (session.toolUses ?? 0) > 0 ||
    (session.tokens ?? 0) > 0 ||
    (!subagentLive(session) && session.activityAt > 0);

// One second ticks every live row's elapsed together — the board's `now` pattern, one timer for the whole list.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

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
    <!-- ON THE CARD SURFACE, which is the popped-out chat's ground (ChatPanel) and not this route's default
         canvas — because the list down the left is that window's list, drawn by the same RailLane and RailCard,
         and a lane means opposite things on the two grounds. `.lane` is mixed FROM canvas, so on canvas it is a
         slab that RISES out of the page and its cards rise again off that; on the card ground it is a trough
         the cards sit flush in. Same three colours, inverted relief — which is exactly how the two lists read
         as two different components to anyone who has both open. The chat's reading is the one that wins: it
         is the surface this list was copied from. -->
    <div class="flex h-full min-h-0 bg-card">
        <!-- Nothing to show. Not an error — plenty of turns never start an agent — so this describes the surface
             instead of reporting a fault, the way the Browsers area's empty state does. FILTERED IS ITS OWN
             SENTENCE: a card counts the children an agent has started for its whole life, while this list holds
             them for minutes after they report, so following a chip whose work is long finished lands exactly
             here — and "no agents started" would be a flat contradiction of the number that was just clicked. -->
        <div v-if="visible.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="users" class="text-2xl text-muted" />
            <div class="text-sm text-content">{{ focus === undefined ? "No agents started" : "Nothing running for this agent" }}</div>
            <div class="max-w-sm text-xs text-muted">
                <template v-if="focus === undefined">
                    When an agent delegates — with its Agent tool, or by driving Codex or Grok from its shell — the agent it started appears here,
                    with its own transcript.
                </template>
                <template v-else>
                    The agents {{ focusTitle }} started have finished and aged out of this list. Its own transcript is the record of what they
                    reported back.
                </template>
            </div>
            <RouterLink v-if="focus !== undefined" :to="{ name: `subagents` }" class="text-xs text-link hover:underline">
                Show every agent
            </RouterLink>
        </div>

        <template v-else>
            <!-- WHICH AGENT. The chat rail's own column: lane slabs of session cards, so the agents an agent
                 started are read exactly the way the agents you started are, two clicks away. -->
            <!-- No divider down its right edge, for the reason the pop-out rail has none: the lane slabs are
                 the structure, and a hairline against a column of them is a second edge saying what the first
                 already said. -->
            <aside class="scrollbar-thin flex w-72 shrink-0 flex-col gap-2 overflow-y-auto p-2">
                <!-- WHAT NARROWED THIS LIST, and the way out of it. A filtered rail that does not say it is
                     filtered is how a reader concludes the sandbox has only ever run two agents. -->
                <RouterLink
                    v-if="focus !== undefined"
                    :to="{ name: `subagents` }"
                    class="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content"
                >
                    <Icon name="comments" class="shrink-0 text-2xs" />
                    <span class="min-w-0 flex-1 truncate">{{ focusTitle }}</span>
                    <span class="shrink-0 text-link">Show all</span>
                </RouterLink>
                <template v-for="lane in lanes" :key="lane.label">
                    <RailLane v-if="lane.rows.length > 0" :label="lane.label" :dot="lane.dot" :count="lane.rows.length">
                        <div class="flex min-w-0 flex-col gap-1.5">
                            <RailCard
                                v-for="session in lane.rows"
                                :key="session.id"
                                :title="titleOf(session)"
                                :provider="providerOf(session)"
                                :status="STATUS[session.status]"
                                :live="liveOf(session)"
                                :now="now"
                                :selected="session.id === selected"
                                @click="select(session.id)"
                            >
                                <template v-if="hasFacts(session)" #meta>
                                    <!-- Backgrounded: the parent went on working instead of waiting. The fact
                                         that explains a child still running under a turn that looks finished. -->
                                    <span
                                        v-if="session.background === true && subagentLive(session)"
                                        v-tooltip.top="`Its parent went on working instead of waiting for it`"
                                        class="shrink-0 rounded-full bg-overlay px-1.5 py-px font-semibold text-subtle"
                                        >bg</span
                                    >
                                    <!-- Whose turn started it. Dropped once the list is already narrowed to one
                                         agent: repeating the answer on every row is not an answer. Cut short
                                         rather than given room — every child of one turn repeats it, so it is
                                         the fact on this line least worth a second row of card height. -->
                                    <span v-if="focus === undefined && parentOf(session) !== undefined" class="flex min-w-0 items-center gap-1">
                                        <Icon name="comments" class="shrink-0 text-2xs" />
                                        <span class="max-w-24 truncate">{{ parentOf(session) }}</span>
                                    </span>
                                    <span v-if="session.agentType !== undefined" class="shrink-0">{{ session.agentType }}</span>
                                    <!-- The MODEL is not on this line, and the omission is the reason the line
                                         fits one row: the tile already wears whose runtime it is, and the exact
                                         model is a thing you read once, on the header of the transcript you
                                         opened — not fourteen times down a rail. -->
                                    <!-- HOW FAR IT HAS GOT, as one chip rather than two: what it has done and
                                         what that has cost answer a single question here ("is this one
                                         working, or is it stuck?"), they are read together, and at this width
                                         a second glyph is what pushed the line onto a second row. Its tokens
                                         are ITS OWN — a parent's cost line and the sum of its children's are
                                         two different true numbers, and this is where a child's are
                                         attributed. -->
                                    <span
                                        v-if="(session.toolUses ?? 0) > 0 || (session.tokens ?? 0) > 0"
                                        v-tooltip.top="`Tool calls · tokens`"
                                        class="shrink-0 tabular-nums"
                                    >
                                        <Icon name="list-check" class="mr-0.5 text-2xs" />{{
                                            [session.toolUses, session.tokens === undefined ? undefined : formatTokens(session.tokens)]
                                                .filter((part) => part !== undefined && part !== 0)
                                                .join(` · `)
                                        }}
                                    </span>
                                    <!-- The age keeps to the settled rows: a live one's clock is the activity
                                         line's ticking elapsed, and two clocks on one card disagree by
                                         construction. It FLOWS with the facts rather than taking the chat
                                         rail's right-aligned slot — a wrapping line pushes an `ml-auto` item
                                         onto a row of its own, and "3m" alone on a row is a fifth of a card's
                                         height spent on the least of its facts. -->
                                    <span v-if="!subagentLive(session) && session.activityAt > 0" class="shrink-0">{{
                                        relativeTime(session.activityAt)
                                    }}</span>
                                </template>
                            </RailCard>
                        </div>
                    </RailLane>
                </template>
            </aside>

            <div class="flex min-w-0 flex-1 flex-col">
                <!-- WHAT IT IS, in the card's own vocabulary (the tile, the title, the status glyph) so the row
                     you pressed and the header you land on read as one agent — and the two ways out of this
                     pane: back to the conversation that started it, and, for a delegation (which unlike a
                     subagent has a process of its own), into the shell it runs in. -->
                <div v-if="current" class="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5 text-2xs text-muted">
                    <IdentityTile :title="titleOf(current)" :provider="providerOf(current)" class="h-5 w-5 text-2xs" />
                    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{ titleOf(current) }}</span>
                    <span v-if="current.agentType !== undefined" class="shrink-0">{{ current.agentType }}</span>
                    <span v-if="current.model !== undefined" class="shrink-0">{{ current.model }}</span>
                    <Icon v-bind="STATUS[current.status]" class="shrink-0" />
                    <span class="flex shrink-0 items-center gap-2">
                        <button
                            v-if="current.terminal"
                            type="button"
                            class="rounded border border-line px-1.5 py-0.5 transition-colors hover:text-content"
                            v-tooltip.bottom="`Watch the shell this agent runs in`"
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
