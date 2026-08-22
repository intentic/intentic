<script setup lang="ts">
import { type AgentProvider, NATIVE_PROVIDERS, type RestoredMessage, type SubagentSession } from "@intentic/sandbox-contract";
import { formatTokens, Icon, type IconName, Markdown, ui, useDevice } from "@intentic/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activityIcon } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/providerCatalog";
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
 * and the same lane slab the floating chat lists its conversations with, and the fleet board's card one column
 * wide. This used to be its own thing: a flat column of bordered rows, its own status glyphs, its own facts in
 * its own order, no identity tile and no card surface, so the agents an AGENT started looked like a different
 * kind of object from the agents the user started, two screens apart in the same app. Everything a row needs
 * beyond the shared card is a fact about delegation and only that: which turn started it, that it was
 * backgrounded, and (for a delegation) the shell it runs in.
 *
 * SAME CARD MEANS SAME FORM AND SAME FACTS. It is the card's `tight` shape here as it is in the chat, so a row
 * is the same height in both lists, and the model rides the facts line here as it does there, so the one thing
 * this list used to leave unanswered ("which model is that child burning?") is answered where it is asked.
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

/* WHICH MODEL IT RUNS ON, in the chat rail's own words (modelLabelFor): the same fact, the same short label,
 * in the same slot on the same card, because the rail here and the rail in the floating chat are read minutes
 * apart by one eye. It used to be left off on the argument that the tile already says whose runtime it is and
 * that the exact model is a header fact: but the tile says `claude`, not which Claude, and "is this the cheap
 * one or the expensive one" is exactly what a column of a dozen delegations is scanned for. Falls back to the
 * runtime's own name when the child never reported a model, which is what the chat's card does too. */
const modelOf = (session: SubagentSession): string | undefined =>
    session.model === undefined || session.model === `` ? undefined : modelLabelFor(providerOf(session), session.model);

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
    modelOf(session) !== undefined ||
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

/* WHAT IT REPORTED BACK, when that is not the same string as how it failed: a delegation's error IS its last
 * output, and the header's own error panel already says it. Lifted out of the template because three things now
 * turn on whether there is a report at all: the block, the label that separates it from the work, and where the
 * column lands when you select this child. */
const report = computed<string | undefined>(() => {
    const summary = current.value?.summary;
    return summary !== undefined && summary !== current.value?.error ? summary : undefined;
});

/* THE REPORT'S CEILING, AND WHY IT IS A CLAMP AND NOT A BOX OF ITS OWN.
 *
 * This pane used to be TWO SCROLLERS stacked: the report in a fixed 14rem letterbox with a scrollbar of its
 * own, the work in the column below it with another. Same ground, same reading column, same type, and nothing
 * whatsoever at the seam — so a long report's clipped last line ran straight into the transcript's first, and
 * the two documents read as one document with a sentence broken in the middle of it. The worse half was
 * invisible: which of the two boxes the wheel moved depended on a boundary the reader had no way to see, so
 * scrolling did one of two different things and the page looked broken rather than dense.
 *
 * The report is now the first block INSIDE the transcript's scroller — one wheel, one column, one scroll
 * position — and the two are told apart the way the rail beside them tells its lanes apart: by a label and by
 * air, not by a hairline this surface has none of. What the letterbox was actually FOR (keeping a long report
 * from pushing the work off the bottom of the page) is what this clamp does, minus the trap: the answer's
 * opening still fits above the fold, the fade says there is more, and asking for the rest grows it in place.
 *
 * Whether there IS a rest has to be measured, not computed: it is a question about wrapped height at the width
 * this pane happens to be, which moves with a dragged panel edge. Same reasoning, same shape as Code.vue. */
const reportExpanded = ref(false);
// Nullable for the reason the pane's ref is: Vue empties a template ref to `null`, both when the element goes
// (a child with no report) and on unmount, so truthiness is the only check that covers it.
const reportBox = ref<HTMLElement | null>(null);
const reportOverflows = ref(false);
const reportClamped = computed(() => !reportExpanded.value);
// Kept once expanded, for Code.vue's reason: the measurement says "nothing more to show" the instant the clamp
// lifts, and a toggle that vanishes on use leaves the reader no way back to the short form.
const reportToggle = computed(() => reportExpanded.value || reportOverflows.value);
const measureReport = (): void => {
    const el = reportBox.value;
    reportOverflows.value = el !== null && el.scrollHeight > el.clientHeight + 1;
};
/* Observed on the CONTENT as well as on the box. While clamped, the box's own height is pinned by its
 * max-height, so it never resizes and an observer watching only it never fires — the report could double in
 * length under a toggle that still said there was nothing more. The prose inside it is what changes. */
/* `flush: post`, so the element observed is the one on screen: the report's markup is re-rendered by the very
 * change that triggers this, and measured before the patch it is the OLD document's height that comes back. */
let reportWatcher: ResizeObserver | undefined;
watch(
    [reportBox, report],
    (_next, _old, onCleanup) => {
        reportWatcher?.disconnect();
        const el = reportBox.value;
        if (!el) {
            reportOverflows.value = false;
            return;
        }
        reportWatcher ??= new ResizeObserver(() => measureReport());
        reportWatcher.observe(el);
        const content = el.firstElementChild;
        if (content !== null) {
            reportWatcher.observe(content);
        }
        measureReport();
        onCleanup(() => reportWatcher?.disconnect());
    },
    { flush: `post` },
);
onUnmounted(() => reportWatcher?.disconnect());

/* WHERE THE ONE COLUMN SITS, which a single scroller has to decide for itself.
 *
 * It used to be simple and wrong: every arriving frame slammed the transcript to the bottom. That was harmless
 * while the report lived in its own box above, and is not now — merged in, an unconditional jump scrolls the
 * answer off the top of the surface the moment the poll returns, and drags the page out from under anyone
 * reading back through the work.
 *
 * So it FOLLOWS rather than forces: a reader already at the foot of the column is one watching it happen and
 * stays pinned there as the child writes; a reader who has scrolled up is left exactly where they are. And the
 * two kinds of child land in the two places worth landing: a running one at the bottom, where the work it is
 * doing this second is, and a finished one at the top, where its report is — that answer being the whole reason
 * the delegation happened. */
// Nullable, not just optional: Vue empties a template ref on unmount by setting it to `null`, and a frame this
// queues can land after the page has gone. Truthiness is the check that covers both, and the reason it is one.
const pane = ref<HTMLElement | null>(null);
// Slack enough that the last line's descenders or a one-pixel rounding never read as "scrolled away".
const FOLLOW_SLACK_PX = 64;
const following = ref(true);
const onPaneScroll = (): void => {
    const el = pane.value;
    if (el) {
        following.value = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
    }
};
const settle = (): void =>
    void requestAnimationFrame(() => {
        const el = pane.value;
        if (el) {
            el.scrollTop = following.value ? el.scrollHeight : 0;
        }
    });
watch(messages, () => {
    if (following.value) {
        settle();
    }
});
/* A different child is a different document: its own clamp state, and its own landing place. Immediate,
 * because the FIRST child shown is picked the same way (the daemon sorts live-first and the rail falls back to
 * row one) — left to the messages watcher alone, landing here on a finished agent would have scrolled its
 * report away before it was read. */
watch(
    selected,
    () => {
        reportExpanded.value = false;
        following.value = current.value !== undefined && subagentLive(current.value);
        settle();
    },
    { immediate: true },
);
</script>

<template>
    <!-- ON THE CARD SURFACE, which is the floating chat's ground (ChatPanel) and not this route's default
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
                    When an agent delegates: with its Agent tool, or by driving Codex or Grok from its shell, the agent it started appears here, with
                    its own transcript.
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
            <!-- No divider down its right edge, for the reason the floating rail has none: the lane slabs are
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
                                    tight
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
                                        <!-- WHICH MODEL, in the chat rail's slot and clipped to its width: the
                                             fact this list was missing, and the one that decides whether a
                                             delegation is worth reading before you open it. -->
                                        <span v-if="modelOf(session) !== undefined" class="max-w-24 truncate">{{ modelOf(session) }}</span>
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
                                        <!-- The age keeps to the settled rows: a live one's clock is the live
                                             readout's ticking elapsed, which on this card now ends the same
                                             line, and two clocks on one card disagree by construction. Right-
                                             aligned, the chat rail's slot: the "when" of a card has one corner
                                             whether or not the turn has ended. -->
                                        <span v-if="!subagentLive(session) && session.activityAt > 0" class="ml-auto shrink-0">{{
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
                    <!-- The same label the row above it wears (modelOf): a header that spelled the raw id while
                         the card said the short name read as two different models. -->
                    <span v-if="modelOf(current) !== undefined" class="shrink-0">{{ modelOf(current) }}</span>
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

                <!-- ONE SCROLLER FOR THE WHOLE COLUMN: the report and the work it summarizes, in that order,
                     down one reading measure (.chat-turns) with one wheel and one scroll position. They were
                     two scrollers, and the pair was the surface's worst edge: identical ground, identical
                     column, identical type, nothing at the seam, so the clipped tail of a long report butted
                     into the transcript's first line and read as one document torn mid-sentence — while which
                     box the wheel actually moved turned on a boundary nothing on screen drew.
                     Merged, the two are told apart the way the rail beside them tells its lanes apart: by a
                     label in the lane header's own voice and by air. No rule between them, for the reason the
                     pane's own header has none — this surface's structure is cards, lanes and gaps, and a
                     hairline here would be its only one. -->
                <div ref="pane" class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto py-2" @scroll.passive="onPaneScroll">
                    <div class="chat-turns">
                        <!-- The two sections' own spacing, set here rather than borrowed from the column's
                             --chat-gap: that gap is the distance between two events INSIDE a transcript, and
                             the distance between the report and the entire transcript is a bigger fact than
                             the distance between one tool call and the next. -->
                        <div class="flex min-w-0 flex-col gap-5">
                            <!-- ITS REPORT, keeping the top of the column: the answer is what the delegation
                                 was for. Two things it must not be: raw, and unbounded. A child's last words
                                 are a document — headings, tables, file references — which poured out as
                                 plain text read as literal asterisks and pipes, so it goes through the
                                 renderer the chat's own prose does. And left unbounded it pushed the work
                                 clean off the bottom of the page, which is what the old letterbox was for;
                                 a clamp with a fade and a toggle does that job without trapping the answer
                                 in a scrollbox the size of a stamp.
                                 That it FAILED is not said in here: the header's status glyph already says
                                 so, and a page of body text in danger red is the least readable way to
                                 repeat it. -->
                            <section v-if="report !== undefined" class="flex min-w-0 flex-col gap-1.5">
                                <span class="text-2xs font-semibold uppercase tracking-wide text-muted">Report</span>
                                <!-- THE CEILING IS A SHARE OF THE WINDOW, not a count of pixels. A fixed one
                                     (this was 14rem, then 20rem) is wrong at both ends: on a tall window it
                                     cut a report off with half the pane standing empty below it, which reads
                                     as damage rather than as a fold; on a short one it left the work no room
                                     at all. Sixty per cent keeps the proportion the two deserve — the answer
                                     takes most of the surface, the work stays visibly present under it — at
                                     every size, and this pane is the window minus a header, so viewport
                                     height is the honest measure of it and costs no observer to read. -->
                                <div ref="reportBox" class="relative" :class="reportClamped ? `max-h-[60vh] overflow-hidden` : undefined">
                                    <Markdown :source="report" :decorate="decorate" class="chat-markdown chat-markdown-compact" />
                                    <!-- The fade is what says "there is more". A hard cut halfway through a
                                         heading is exactly what made this block read as a rendering fault. -->
                                    <div
                                        v-if="reportClamped && reportOverflows"
                                        class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-card to-transparent"
                                    ></div>
                                </div>
                                <button
                                    v-if="reportToggle"
                                    type="button"
                                    :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content hover:no-underline`)"
                                    @click="reportExpanded = !reportExpanded"
                                >
                                    {{ reportExpanded ? `Show less` : `Show the full report` }}
                                    <Icon :name="reportExpanded ? `chevron-up` : `chevron-down`" />
                                </button>
                            </section>

                            <!-- ITS WORK, in the chat's own shapes: prose as prose, tool calls as the very
                                 cards the conversation draws (children and all: a child that itself delegates
                                 nests here too). Its label earns its row only when there is a report above to
                                 be told apart from — heading a pane that holds nothing else is decoration,
                                 and this column has no air to spend on any. -->
                            <section class="flex min-w-0 flex-col gap-1.5">
                                <span v-if="report !== undefined" class="text-2xs font-semibold uppercase tracking-wide text-muted">Work</span>
                                <div class="chat-stack flex min-w-0 flex-col">
                                    <div v-for="(message, index) in messages" :key="index" class="chat-stack flex flex-col">
                                        <!-- The prompt it was given reads as a prompt: the same right-aligned
                                             bubble the chat gives the user's own words, because from the
                                             child's side that is what it is. -->
                                        <p
                                            v-if="message.role === 'user'"
                                            class="self-end whitespace-pre-wrap rounded-lg bg-overlay px-2.5 py-1.5 text-xs leading-relaxed text-content"
                                        >
                                            {{ message.text }}
                                        </p>
                                        <template v-else>
                                            <div v-if="message.thinking" class="text-2xs italic leading-relaxed text-subtle">
                                                {{ message.thinking }}
                                            </div>
                                            <!-- <Markdown> brings `md-prose` with it, which is what dresses the
                                                 output: every rule in prose.css hangs off that class, and
                                                 rendered without it the headings, lists, tables and code blocks
                                                 all came out as undifferentiated body text. `chat-markdown` is
                                                 only the transcript's tuning of those tokens. -->
                                            <Markdown v-if="message.text" :source="message.text" :decorate="decorate" class="chat-markdown" />
                                            <ChatToolCard
                                                v-for="tool in message.tools ?? []"
                                                :key="tool.id"
                                                :tool="tool"
                                                :live="current !== undefined && subagentLive(current)"
                                            />
                                        </template>
                                    </div>
                                    <!-- WHERE THE LIVE VIEW COMES FROM, said out loud. A running child is read
                                         out of its parent turn's stream, which fills in as it works, so an
                                         empty pane here means "nothing yet", not "nothing is coming", and
                                         those two read identically when the surface says neither. -->
                                    <p v-if="messages.length === 0" class="px-1 py-3 text-center text-2xs text-subtle">
                                        {{
                                            current !== undefined && subagentLive(current)
                                                ? "Watching live: what this agent writes lands here as it works."
                                                : "No transcript was recorded for this agent."
                                        }}
                                    </p>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>
