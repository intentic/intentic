<script setup lang="ts">
import { type AgentProvider, NATIVE_PROVIDERS, type RestoredMessage, type SubagentSession } from "@intentic/sandbox-contract";
import { formatTokens, Icon, type IconName, Markdown, useDevice } from "@intentic/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activityIcon } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { SUBAGENT_TRANSCRIPT } from "../composables/queryKeys";
import { subagentLive, useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { openWorkTerminal } from "../composables/terminal/useWorkTerminals";
import { CHAT_SURFACE } from "../chat/chatSurface";
import { workspaceSurface } from "../chat/workspaceSurface";
import ChatToolCard from "../chat/ChatToolCard.vue";
import ProviderLogo from "../chat/ProviderLogo.vue";
import ActionLink from "../components/ActionLink.vue";
import IdentityTile from "../components/IdentityTile.vue";
import RailCard from "../components/RailCard.vue";
import RailLane from "../components/RailLane.vue";
import { fileLinkDecorator } from "../composables/renderMarkdown";

/* THE AGENTS THIS SANDBOX'S AGENTS STARTED: the third surface of the same kind, after the terminal panel and the
 * Browsers area. A turn's shell and its browser were already things the operator could open and look at; the
 * agents it starts were not, which is the one of the three that is itself an agent and the one most likely to be
 * doing something you would want to see.
 *
 * WHY IT IS A ROUTE AND NOT A PANE. A subagent has no byte stream and no live page: the thing you watch it
 * through is its TRANSCRIPT, which wants a column, not a strip. So the shape is the Browsers area's: a list down
 * the left answering "which agent?", the selected one's work filling the rest, and the content is the chat's own,
 * rendered by the very components the conversation uses (ChatToolCard), because a child's work should read exactly
 * like its parent's.
 *
 * THE LIST IS THE CHAT RAIL'S, NOT A SECOND LIST OF SESSIONS. Its rows are RailCard on RailLane: the same card
 * and the same lane slab the popped-out chat lists its conversations with, and the fleet board's card one column
 * wide. This used to be its own thing: a flat column of bordered rows, its own status glyphs, its own facts in
 * its own order, no identity tile and no card surface, so the agents an AGENT started looked like a different
 * kind of object from the agents the user started, two screens apart in the same app. Everything a row needs
 * beyond the shared card is a fact about delegation and only that: which turn started it, that it was
 * backgrounded, and (for a delegation) the shell it runs in.
 *
 * TWO KINDS IN ONE LIST, deliberately: an Agent/Task subagent and a `codex exec` the agent drove from its own
 * shell are the same fact from out here: another agent, working, that you did not start. What differs is only
 * how you watch it live, and a delegation says so by offering its terminal. */

// The transcript is the one thing here still read on a clock: a running child's frames arrive in bursts, and
// nothing announces a line of transcript the way the registry announces the child itself. The roster beside it
// is pushed, and is what answers "is it still going" between reads.
const TRANSCRIPT_POLL_MS = 4000;

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { sessions } = useSubagentsQuery();
const { agentById, open: openAgent } = useAgents();

/* ONE AGENT'S CHILDREN, when the card's chip is what opened this. The chip is a fact about ONE agent: "this
 * one started five", and following it into a list of everything every agent in the sandbox has spawned makes
 * the reader do the filtering the click already expressed. Carried as a query rather than a route of its own so
 * the id in the path keeps meaning the selected child, and so "show all" is a link that drops one parameter. */
const focus = computed<string | undefined>(() => (typeof route.query[`agent`] === `string` ? route.query[`agent`] : undefined));
const focusTitle = computed(() => (focus.value === undefined ? undefined : (agentById(focus.value)?.title ?? `this agent`)));
const visible = computed(() =>
    focus.value === undefined ? sessions.value : sessions.value.filter((session) => session.conversationId === focus.value),
);

// The subagent in the URL, so a reload (or the card's link) opens the same one. Falls back to the first listed:
// which the daemon sorts live-first, so landing here with no id shows what is happening now.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`id`] === `string` ? route.params[`id`] : undefined;
    if (named !== undefined && visible.value.some((session) => session.id === named)) {
        return named;
    }
    return visible.value[0]?.id;
});
const current = computed(() => visible.value.find((session) => session.id === selected.value));

/* What THIS page's tool cards can lead to (chatSurface.ts). A child's work is drawn by the very components the
 * conversation uses, and those cards are mounted outside any chat pane here, so the page states its own
 * surface rather than inheriting a pane's. Files and pictures resolve; there is no shell or browser to offer,
 * because the live views a child has are the page's own, not a card's.
 *
 * The paths a child named are its PARENT's tree: a subagent runs inside the conversation that started it, so an
 * isolated parent's worktree is where its files are. A parent holding a branch is what "isolated" looks like
 * from the roster. */
provide(
    CHAT_SURFACE,
    workspaceSurface({
        agent: () => {
            const conversationId = current.value?.conversationId;
            return conversationId !== undefined && agentById(conversationId)?.branch !== undefined ? conversationId : undefined;
        },
        // A child that delegated further links to ITS child's transcript, which is this same page: routed
        // rather than reloaded.
        navigate: (to) => void router.push(to),
    }),
);

/* Selecting keeps whatever narrowed the list: a click inside a filtered rail must not silently widen it.
 * A ROUTE, so the row is a link (RailCard's `to`): every one of these transcripts has an address, and
 * Ctrl/⌘-click opens one beside the list instead of taking the list's place. */
const rowTo = (id: string) => ({ name: `subagents`, params: { id }, query: route.query });

// Running first, then what has finished: the two questions this list is opened with, in that order. The dots
// are the board's own (ChatTabList's LANES): live is success, the terminal shelf is neutral.
const lanes = computed<{ readonly label: string; readonly dot: string; readonly rows: SubagentSession[] }[]>(() => [
    { label: `Running`, dot: `bg-success`, rows: visible.value.filter(subagentLive) },
    { label: `Finished`, dot: `bg-line-strong`, rows: visible.value.filter((session) => !subagentLive(session)) },
]);

/* The row's heading: WHAT IT WAS ASKED TO DO. The card's one piece of content, so the description takes it
 * whole: the type it runs as (`Explore`, `general-purpose`) is a fact ABOUT the row and rides the meta line
 * with the rest of them. It used to lead the title, where on a rail this wide it ate the half of the line that
 * says which of fourteen children this one is: every row began "general-purpose · " and the descriptions were
 * clipped at the point they started to differ. */
const titleOf = (session: SubagentSession): string =>
    [session.description, session.agentType].find((part) => part !== undefined && part !== ``) ?? `Agent ${session.id.slice(-6)}`;
// Which agent's turn started it: the way back to the conversation this all came out of.
const parentOf = (session: SubagentSession): string | undefined => agentById(session.conversationId)?.title ?? undefined;

/* THE WAY BACK, AND WHERE "BACK" IS. A conversation lives on exactly one surface per form factor: the docked
 * chat on desktop, the drill-in page on a phone, which has none. This used to be a plain link to /agents/:id
 * for both, and on desktop that route is the REVIEW page, so asking for the parent CONVERSATION swapped this
 * whole area for a diff nobody had asked to see. Now it points the dock at the parent and leaves the child's
 * transcript on screen, which is the pairing the press is for: the delegation beside the turn that made it.
 * Falls back to the route when the roster has never heard of the parent: that page knows how to go and ask. */
const parentTo = (session: SubagentSession): string => `/agents/${encodeURIComponent(session.conversationId)}`;
const openParent = (session: SubagentSession): void => {
    const parent = agentById(session.conversationId);
    if (parent !== undefined && !mobile.value) {
        openAgent(parent);
        return;
    }
    void router.push(parentTo(session));
};

/* WHO IS ACTUALLY RUNNING IT, for the identity tile's fallback mark, and for a delegation that is the row's
 * whole point: a `codex exec` the agent drove from its shell is another vendor's agent working in this sandbox,
 * and a row that doesn't say so reads as one of ours. An SDK subagent runs inside its parent's own turn, so it
 * wears the parent's provider, falling back to Claude once the roster no longer holds the parent. */
const providerOf = (session: SubagentSession): AgentProvider =>
    session.kind === `subagent` ? (agentById(session.conversationId)?.provider ?? `claude`) : session.kind;

/* THE BRAND MARK FOR AN AGENT TYPE THAT NAMES A RUNTIME. `claude` set as a lowercase word among the header's
 * other grey facts reads as a stray label rather than as the vendor it is; the same fact as a glyph is read in
 * one pass and costs a fifth of the width. Only the native runtimes have a mark: an `Explore` or a
 * `general-purpose` is a WORD, and a word is what says it. */
const typeMark = (session: SubagentSession): AgentProvider | undefined =>
    session.agentType !== undefined && (NATIVE_PROVIDERS as readonly string[]).includes(session.agentType) ? session.agentType : undefined;

/* The header's two actions, drawn the way the rail's cards are: no box until you are on them. A hairline
 * button on a surface whose whole structure is card-and-lane is a third kind of edge, and two of them in the
 * corner of an otherwise borderless header is what made this bar read as a toolbar bolted to the top. */
const HEADER_ACTION = `flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-overlay hover:text-content`;

// The SDK's own task vocabulary, ready to `v-bind` onto the Icon: the shape agentStatusMeta returns for a
// fleet agent, so the rail's glyph slot is fed the same way here as it is there.
const STATUS: Record<SubagentSession["status"], { name: IconName; spin?: boolean; class: string; "aria-label": string }> = {
    pending: { name: `clock`, class: `text-xs text-subtle`, "aria-label": `Queued` },
    running: { name: `spinner`, spin: true, class: `text-xs text-link`, "aria-label": `Running` },
    blocked: { name: `question-circle`, class: `text-xs text-warning`, "aria-label": `Needs input` },
    paused: { name: `clock`, class: `text-xs text-warning`, "aria-label": `Paused` },
    completed: { name: `check`, class: `text-xs text-success`, "aria-label": `Completed` },
    failed: { name: `times`, class: `text-xs text-danger`, "aria-label": `Failed` },
    killed: { name: `stop`, class: `text-xs text-subtle`, "aria-label": `Killed` },
};

/* THE LIVE LINE, the board's own: what it is doing this second and how long it has been at it, in link, the
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
    // A blocked child says what it is waiting on: the delegate's own words (noteDelegationSignal put them in
    // `summary`), because "Needs input" alone sends the user hunting for the question.
    if (session.status === `blocked`) {
        return { icon: `question-circle`, text: session.summary ?? `Needs input`, since: session.startedAt };
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

// One second ticks every live row's elapsed together: the board's `now` pattern, one timer for the whole list.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

/* THE SELECTED CHILD'S TRANSCRIPT. Polled while it runs and read once when it has finished: the daemon serves a
 * live one out of its parent turn's frame log and a settled one out of whichever store ran it, so this side needs
 * to know neither (see sessions/subagent-transcript.ts). */
const transcript = useQuery({
    queryKey: computed(() => SUBAGENT_TRANSCRIPT.of(selected.value ?? ``)),
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

// A child's prose is the chat's prose: the same component the transcript renders an answer with, so a report
// that draws a diagram draws it here too. The decorator is built once rather than in the template: it is a
// prop, and a new function every frame would re-parse every message on every render. No agent scope: a child
// works in its parent's tree, and the paths it names are that tree's.
const decorate = fileLinkDecorator();

// The transcript pane scrolls itself to the bottom as a running child writes: the same expectation the chat sets.
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
         canvas, because the list down the left is that window's list, drawn by the same RailLane and RailCard,
         and a lane means opposite things on the two grounds. `.lane` is mixed FROM canvas, so on canvas it is a
         slab that RISES out of the page and its cards rise again off that; on the card ground it is a trough
         the cards sit flush in. Same three colours, inverted relief, which is exactly how the two lists read
         as two different components to anyone who has both open. The chat's reading is the one that wins: it
         is the surface this list was copied from. -->
    <!-- Clipped to its own surface. Everything inside is height-bounded, and this is the guard that says so:
         a block that outgrows the column used to paint straight down the page past the card ground, so the
         report ran on over the shell's own background with the rail stopping short beside it. -->
    <div class="flex h-full min-h-0 overflow-hidden bg-card">
        <!-- Nothing to show. Not an error: plenty of turns never start an agent, so this describes the surface
             instead of reporting a fault, the way the Browsers area's empty state does. FILTERED IS ITS OWN
             SENTENCE: a card counts the children an agent has started for its whole life, while this list holds
             them for minutes after they report, so following a chip whose work is long finished lands exactly
             here, and "no agents started" would be a flat contradiction of the number that was just clicked. -->
        <div v-if="visible.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon name="users" class="text-2xl text-muted" />
            <div class="text-sm text-content">{{ focus === undefined ? "No agents started" : "Nothing running for this agent" }}</div>
            <div class="max-w-sm text-xs text-muted">
                <template v-if="focus === undefined">
                    When an agent delegates: with its Agent tool, or by driving Codex or Grok from its shell, the agent it started appears here,
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
            <!-- THE GUTTER IS ON THE FRAME, NOT ON THE SCROLLER: the shape the docked rail uses (ChatTabs
                 pads the sheet, ChatTabList's scroller has no padding of its own), and here it is load-bearing:
                 a scroll container's padding insets where its sticky children COME TO REST but not where it
                 CLIPS, so with the padding on the scroller the lane's cap pinned eight pixels below the top of
                 the rail and every card scrolled through the strip above it: a sliver of card, selection ring
                 and all, riding over the header. -->
            <div class="flex w-72 shrink-0 flex-col p-2">
                <aside class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                    <!-- WHAT NARROWED THIS LIST, and the way out of it. A filtered rail that does not say it is
                         filtered is how a reader concludes the sandbox has only ever run two agents. -->
                    <RouterLink
                        v-if="focus !== undefined"
                        :to="{ name: `subagents` }"
                        class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    >
                        <Icon name="comments" class="shrink-0 text-2xs" />
                        <span class="min-w-0 flex-1 truncate">{{ focusTitle }}</span>
                        <span class="shrink-0 text-link">Show all</span>
                    </RouterLink>
                    <template v-for="lane in lanes" :key="lane.label">
                        <RailLane v-if="lane.rows.length > 0" :label="lane.label" :dot="lane.dot" :count="lane.rows.length">
                            <div class="flex min-w-0 flex-col gap-2">
                                <RailCard
                                    v-for="session in lane.rows"
                                    :key="session.id"
                                    :title="titleOf(session)"
                                    :provider="providerOf(session)"
                                    :status="STATUS[session.status]"
                                    :live="liveOf(session)"
                                    :now="now"
                                    :selected="session.id === selected"
                                    :to="rowTo(session.id)"
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
                                             rather than given room: every child of one turn repeats it, so it is
                                             the fact on this line least worth a second row of card height. -->
                                        <span v-if="focus === undefined && parentOf(session) !== undefined" class="flex min-w-0 items-center gap-1">
                                            <Icon name="comments" class="shrink-0 text-2xs" />
                                            <span class="max-w-24 truncate">{{ parentOf(session) }}</span>
                                        </span>
                                        <span v-if="session.agentType !== undefined" class="shrink-0">{{ session.agentType }}</span>
                                        <!-- The MODEL is not on this line, and the omission is the reason the line
                                             fits one row: the tile already wears whose runtime it is, and the exact
                                             model is a thing you read once, on the header of the transcript you
                                             opened, not fourteen times down a rail. -->
                                        <!-- HOW FAR IT HAS GOT, as one chip rather than two: what it has done and
                                             what that has cost answer a single question here ("is this one
                                             working, or is it stuck?"), they are read together, and at this width
                                             a second glyph is what pushed the line onto a second row. Its tokens
                                             are ITS OWN: a parent's cost line and the sum of its children's are
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
                                             rail's right-aligned slot: a wrapping line pushes an `ml-auto` item
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
            </div>

            <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!-- WHAT IT IS, in the card's own vocabulary (the tile, the title, the status glyph) so the row
                     you pressed and the header you land on read as one agent, and the two ways out of this
                     pane: back to the conversation that started it, and, for a delegation (which unlike a
                     subagent has a process of its own), into the shell it runs in. -->
                <!-- NO RULE UNDER IT. The rail beside it is lane slabs on a card ground and draws not one
                     hairline; a line across the top of the pane put the only border on the surface exactly
                     where the eye lands first, and cut the header off from the transcript it names. Height and
                     the title's weight are what separate them now: the same way the lanes separate the rail. -->
                <div v-if="current" class="flex shrink-0 items-center gap-2 px-3 py-2 text-2xs text-muted">
                    <IdentityTile :title="titleOf(current)" :provider="providerOf(current)" class="h-5 w-5 text-2xs" />
                    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{ titleOf(current) }}</span>
                    <!-- Wrapped rather than tooltipped directly: the mark is a component, and the note is what
                         keeps the glyph from being a fact only the people who already know it can read. -->
                    <span
                        v-if="typeMark(current) !== undefined"
                        v-tooltip.bottom="`Runs as ${current.agentType}`"
                        class="flex shrink-0 items-center text-sm text-subtle"
                    >
                        <ProviderLogo :provider="typeMark(current)!" />
                    </span>
                    <span v-else-if="current.agentType !== undefined" class="shrink-0">{{ current.agentType }}</span>
                    <span v-if="current.model !== undefined" class="shrink-0">{{ current.model }}</span>
                    <Icon v-bind="STATUS[current.status]" class="shrink-0" />
                    <button
                        v-if="current.terminal"
                        type="button"
                        :class="HEADER_ACTION"
                        v-tooltip.bottom="`Watch the shell this agent runs in`"
                        @click="openWorkTerminal(current.terminal)"
                    >
                        <Icon name="terminal" class="text-2xs" />Terminal
                    </button>
                    <!-- A control AND an address (ActionLink): the plain click points the docked chat at the
                         parent, which is better than a page load; Ctrl/⌘-click opens that conversation's own
                         page in a tab, which a <button> could never offer. -->
                    <ActionLink
                        :to="parentTo(current)"
                        :class="HEADER_ACTION"
                        v-tooltip.bottom="`Open the conversation that started this agent`"
                        @activate="openParent(current)"
                    >
                        <Icon name="comments" class="text-2xs" />Parent
                    </ActionLink>
                </div>
                <!-- HOW IT ENDED, when that was badly. Plain text, because an error string is a string and
                     not a document, and separate from the report below, which for a delegation is the same
                     tail of the same output and must not be said twice. Held apart from the transcript by its
                     own tinted panel rather than by rules above and below it: the colour already says this
                     block is not the conversation, and a hairline is the app's least specific way to repeat it. -->
                <p v-if="current?.error" class="mx-3 shrink-0 whitespace-pre-wrap rounded-md bg-danger/10 px-2 py-1.5 text-2xs text-danger">
                    {{ current.error }}
                </p>

                <!-- ITS REPORT, above its work: the answer is what the delegation was for, so it keeps the
                     top of the column. Two things it must not be: raw, and unbounded. A child's last words
                     are a document: headings, tables, file references, which poured out as plain text read
                     as literal asterisks and pipes, so it goes through the renderer the chat's own prose
                     does. And a long one grew this column taller than the surface under it, which is what
                     put the transcript off the bottom of the page; a ceiling of its own to scroll inside is
                     what keeps the work below it reachable. It takes the transcript's column (.chat-turns)
                     so the report and the work it summarizes share one left edge and one reading width.
                     That it FAILED is not said in here: the header's status glyph already says so, and a
                     page of body text in danger red is the least readable way to repeat it. -->
                <div
                    v-if="current?.summary !== undefined && current.summary !== current.error"
                    class="scrollbar-thin max-h-56 shrink-0 overflow-y-auto py-2"
                >
                    <Markdown :source="current.summary" :decorate="decorate" class="chat-turns chat-markdown chat-markdown-compact" />
                </div>

                <!-- ITS WORK, in the chat's own shapes: prose as prose, tool calls as the very cards the
                     conversation draws (children and all: a child that itself delegates nests here too):
                     and on the chat's own column (.chat-turns), for the reason that column exists. Left to
                     fill this pane, a report's paragraphs ran past 200 characters a line on a wide window,
                     which is where the eye loses the start of the next one. -->
                <div ref="pane" class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
                    <div class="chat-turns flex flex-col">
                        <div v-for="(message, index) in messages" :key="index" class="chat-stack flex flex-col">
                            <!-- The prompt it was given reads as a prompt: the same right-aligned bubble the
                                 chat gives the user's own words, because from the child's side that is what
                                 it is. -->
                            <p
                                v-if="message.role === 'user'"
                                class="self-end whitespace-pre-wrap rounded-lg bg-overlay px-2.5 py-1.5 text-xs leading-relaxed text-content"
                            >
                                {{ message.text }}
                            </p>
                            <template v-else>
                                <div v-if="message.thinking" class="text-2xs italic leading-relaxed text-subtle">{{ message.thinking }}</div>
                                <!-- <Markdown> brings `md-prose` with it, which is what dresses the output:
                                     every rule in prose.css hangs off that class, and rendered without it the
                                     headings, lists, tables and code blocks all came out as undifferentiated
                                     body text. `chat-markdown` is only the transcript's tuning of those
                                     tokens. -->
                                <Markdown v-if="message.text" :source="message.text" :decorate="decorate" class="chat-markdown" />
                                <ChatToolCard
                                    v-for="tool in message.tools ?? []"
                                    :key="tool.id"
                                    :tool="tool"
                                    :live="current !== undefined && subagentLive(current)"
                                />
                            </template>
                        </div>
                        <!-- WHERE THE LIVE VIEW COMES FROM, said out loud. A running child is read out of its
                             parent turn's stream, which fills in as it works, so an empty pane here means
                             "nothing yet", not "nothing is coming", and those two read identically when the
                             surface says neither. -->
                        <p v-if="messages.length === 0" class="px-1 py-3 text-center text-2xs text-subtle">
                            {{
                                current !== undefined && subagentLive(current)
                                    ? "Watching live: what this agent writes lands here as it works."
                                    : "No transcript was recorded for this agent."
                            }}
                        </p>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>
