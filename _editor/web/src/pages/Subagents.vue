<script setup lang="ts">
import { type AgentProvider, NATIVE_PROVIDERS, providerLabel, type RestoredMessage, type SubagentSession } from "@intentic/sandbox-contract";
import { Icon, type IconName, Markdown, ui, useDevice } from "@intentic/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activityIcon } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { sessionCategory } from "../composables/sessionCategory";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { SUBAGENT_TRANSCRIPT } from "../composables/queryKeys";
import { subagentLive, useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { CHAT_SURFACE } from "../chat/chatSurface";
import { workspaceSurface } from "../chat/workspaceSurface";
import { useToolCalls } from "../composables/chat/useToolCalls";
import ChatThinking from "../chat/ChatThinking.vue";
import ChatToolCallsToggle from "../chat/ChatToolCallsToggle.vue";
import ChatToolRows from "../chat/ChatToolRows.vue";
import ChatToolRun from "../chat/ChatToolRun.vue";
import ProviderLogo from "../chat/ProviderLogo.vue";
import ActionLink from "../components/ActionLink.vue";
import IdentityTile from "../components/IdentityTile.vue";
import RailCard from "../components/RailCard.vue";
import RailColumn from "../components/RailColumn.vue";
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
 * rendered by the very components the conversation uses (ChatThinking, ChatToolRows/ChatToolRun) and governed by
 * the same preference (useToolCalls), because a child's work should read exactly like its parent's — including
 * when the reader has folded the tool calls away.
 *
 * WHAT IT HAS NO COMPOSER FOR. The chat's footer is missing here because there is nothing to send: steering a
 * child goes through the daemon's `/children/send` door, which is a SUPERVISION call and admits only a shell
 * carrying a live turn stamp (children/children.routes.ts) — an agent talking to the agent it started. A person
 * reaches a child through its parent, so the header's "Parent" is the outward action this pane has, and the
 * tool-calls toggle takes the slot the composer's status strip would have carried it in.
 *
 * THE LIST IS THE CHAT RAIL'S, NOT A SECOND LIST OF SESSIONS. Its rows are RailCard on RailLane inside
 * RailColumn: the same card, the same lane slab and the same column the floating chat lists its conversations
 * in, down to the width, which is one shared number rather than two that happen to agree (composables/rail.ts).
 * This used to be its own thing: a flat column of bordered rows, its own status glyphs, its own facts in
 * its own order, no identity tile and no card surface, so the agents an AGENT started looked like a different
 * kind of object from the agents the user started, two screens apart in the same app. A row needs NOTHING
 * beyond the shared card now: what is particular about a child — what it runs as, and which conversation it came
 * out of — is answered about the ONE child being read, in the pane's header, which is where one child is read.
 *
 * SAME CARD MEANS SAME FORM AND SAME FACTS, and the facts are the CHAT RAIL'S, not a superset of them. It is
 * the card's `tight` shape here as it is there, so a row is the same height in both lists; and it carries what
 * that card carries — the model, the age of a settled row, the live readout in the corner — because a rail is a
 * switcher and those are the three facts that decide which row to open. The four that used to sit ahead of them
 * (`bg`, the parent's clipped title, the agent type, a tool-call/token counter) are accounted for at `hasFacts`:
 * the one thing this list used to leave unanswered was "which model is that child burning?", which is precisely
 * what they were crowding out.
 *
 * TWO KINDS IN ONE LIST, deliberately: an Agent/Task subagent and a full agent the daemon spawned for the turn
 * are the same fact from out here: another agent, working, that you did not start. What differs is only how you
 * watch it live: a spawned child is a conversation of its own. */

// The transcript is the one thing here still read on a clock: a running child's frames arrive in bursts, and
// nothing announces a line of transcript the way the registry announces the child itself. The roster beside it
// is pushed, and is what answers "is it still going" between reads.
const TRANSCRIPT_POLL_MS = 4000;

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { sessions } = useSubagentsQuery();
const { agentById, open: openAgent } = useAgents();
/* WHETHER THE WORK BELOW DRAWS ITS TOOL CALLS: the chat's own account preference, read here for the reason it
 * is read there. A child's transcript IS a transcript, and it is the same person reading both; one of the two
 * surfaces quietly ignoring the setting is how "hide tool calls" came to mean "except over there". The header
 * carries the control (ChatToolCallsToggle) because this pane has no composer to put a status strip under. */
const { showToolCalls } = useToolCalls();

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
 * whole: the type it runs as (`Explore`, `general-purpose`) is a fact ABOUT the row and belongs to the pane
 * header, which names the ONE child being read rather than repeating a word down a column of fourteen. It used
 * to lead the title, where on a rail this wide it ate the half of the line that says which of fourteen children
 * this one is: every row began "general-purpose · " and the descriptions were clipped at the point they started
 * to differ. */
const titleOf = (session: SubagentSession): string =>
    [session.description, session.agentType].find((part) => part !== undefined && part !== ``) ?? `Agent ${session.id.slice(-6)}`;

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

/* WHO IS ACTUALLY RUNNING IT, for the identity tile's fallback mark. An SDK subagent runs inside its parent's
 * own turn, so it wears the parent's provider, falling back to Claude once the roster no longer holds the
 * parent. A spawned child names its provider on the wire, the row's whole point being that it can be ANY
 * connected one. */
const providerOf = (session: SubagentSession): AgentProvider =>
    session.kind === `subagent` ? (agentById(session.conversationId)?.provider ?? `claude`) : (session.provider ?? `claude`);

/* WHICH MODEL IT RUNS ON, in the chat rail's own words (modelLabelFor): the same fact, the same short label,
 * in the same slot on the same card, because the rail here and the rail in the floating chat are read minutes
 * apart by one eye. The tile says `claude`, not WHICH Claude, and "is this the cheap one or the expensive one"
 * is exactly what a column of a dozen delegations is scanned for.
 *
 * AND IT IS NEVER LEFT BLANK, which it usually was: the daemon learns a child's model from the SDK's own
 * per-subagent meta file, and that file is read when the child's transcript is opened, not when the child is
 * born (agent/subagents.ts) — so the fact this card is scanned for was missing from precisely the rows still
 * running. Three sources, best first:
 *   · what the child itself reported, which is the only one that can name an OVERRIDE (the Agent tool's
 *     `model` argument, a haiku fan-out under an opus parent);
 *   · the PARENT's model, which is what an SDK subagent inherits when the call named none: it runs inside its
 *     parent's own turn, so this is not a guess about the child, it is where the child's tokens are being
 *     billed. `inherited` says so on hover rather than passing it off as the child's own reading;
 *   · the runtime's own name, under the chat card's own floor rule (AgentCard's): a card says WHO RUNS IT
 *     exactly once, so the provider is spelled out here only when the identity tile is wearing a category
 *     glyph instead of the provider mark — which is the same question `sessionCategory` answers for the tile. */
const modelOf = (session: SubagentSession): { label: string; inherited: boolean } | undefined => {
    const provider = providerOf(session);
    if (session.model !== undefined && session.model !== ``) {
        return { label: modelLabelFor(provider, session.model), inherited: false };
    }
    const parent = session.kind === `subagent` ? agentById(session.conversationId)?.model : undefined;
    if (parent !== undefined && parent !== ``) {
        return { label: modelLabelFor(provider, parent), inherited: true };
    }
    return sessionCategory(titleOf(session)) === undefined ? undefined : { label: providerLabel(provider), inherited: false };
};

/* THE BRAND MARK FOR AN AGENT TYPE THAT NAMES A RUNTIME. `claude` set as a lowercase word among the header's
 * other grey facts reads as a stray label rather than as the vendor it is; the same fact as a glyph is read in
 * one pass and costs a fifth of the width. Only the native runtimes have a mark: an `Explore` or a
 * `general-purpose` is a WORD, and a word is what says it. */
const typeMark = (session: SubagentSession): AgentProvider | undefined =>
    session.agentType !== undefined && (NATIVE_PROVIDERS as readonly string[]).includes(session.agentType) ? session.agentType : undefined;

/* The header's actions, drawn the way the rail's cards are: no box until you are on them. A hairline button on
 * a surface whose whole structure is card-and-lane is a third kind of edge, and two of them in the corner of an
 * otherwise borderless header is what made this bar read as a toolbar bolted to the top.
 *
 * Two spellings of one box, because one of these actions is a COMPONENT that already lays itself out
 * (ChatToolCallsToggle is `inline-flex` and positions a slash against itself): handing it the row half as well
 * would be two `display` rules on one element, decided by stylesheet order. So the box is stated once and the
 * row is what the plain elements add to it. */
const HEADER_ACTION_BOX = `shrink-0 rounded-md px-1.5 py-1 transition-colors hover:bg-overlay hover:text-content`;
const HEADER_ACTION = `flex items-center gap-1 ${HEADER_ACTION_BOX}`;

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

/* DID ANYTHING CHECK THE WORK THIS REPORT DESCRIBES (SubagentVerificationSchema, computed daemon-side from
 * the child's own tool calls). It sits with the report rather than with the status glyph on purpose: `completed`
 * says the agent stopped, this says whether what it stopped on was ever tested, and the second is the one a
 * reader is about to act on.
 *
 * All four states are shown here, including the two the daemon deliberately does not spend the PARENT's context
 * on (child-verification.ts). A person reading a report is asking the question; a model that has just been
 * handed one is not, which is why the two surfaces differ. */
const VERIFICATION: Record<NonNullable<SubagentSession["verification"]>["state"], { name: IconName; class: string; text: string }> = {
    verified: { name: `check-circle`, class: `text-success`, text: `Verified` },
    unproven: { name: `exclamation-triangle`, class: `text-warning`, text: `Unproven` },
    failing: { name: `exclamation-circle`, class: `text-danger`, text: `Check failed` },
    "no-code": { name: `file`, class: `text-muted`, text: `Changed no code` },
};

// The sentence beside that word: what it stands on, in the reader's terms. Nothing for `no-code`, whose chip
// already says the whole of it.
const verificationDetail = (verification: NonNullable<SubagentSession["verification"]>): string | undefined => {
    const files = verification.paths ?? [];
    const changed = `${files.length} ${files.length === 1 ? `file` : `files`}`;
    if (verification.state === "verified") {
        return verification.check === undefined ? `a check passed after its last edit` : `${verification.check} passed after its last edit`;
    }
    if (verification.state === "unproven") {
        return `changed ${changed}, and no check passed after the last edit`;
    }
    if (verification.state === "failing") {
        return verification.check === undefined ? `a check after its edits did not pass` : `${verification.check} did not pass`;
    }
    return undefined;
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
 * title on a child the daemon has only just heard of.
 *
 * WHAT THIS LINE NO LONGER CARRIES, AND WHY: this rail is a SWITCHER, and it had drifted into a dashboard —
 * `bg`, the parent's clipped title, the agent type, and a tool-call/token counter, four facts wide, ahead of
 * the one the reader came for. Not one of them ever decided which of a dozen children to open: the type is
 * already the title of any child that has no description and is spelled in full in the pane header; the
 * parent's title arrived clipped to three words ("package.json an…") and is one press away as "Parent"; `bg`
 * and the counters are a running child's own readout, which the live line beside them gives in the words that
 * mean something ("Read · 30s"). What they did do was crowd out the MODEL and push the live readout onto a row
 * of its own, buying every card a third more height in the one place height is scarcest. So the line is now
 * exactly the chat rail's (ChatTabList): the model, the age of a settled row, and the live readout in the
 * corner — because the two lists are read minutes apart by one eye. */
const hasFacts = (session: SubagentSession): boolean => modelOf(session) !== undefined || (!subagentLive(session) && session.activityAt > 0);

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
    <div class="lane-ground-card flex h-full min-h-0 overflow-hidden bg-card">
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
            <!-- THE COLUMN IS THE CHAT'S OWN (RailColumn): the same width, the same gutter and the same drag
                 as the rail the floating chat lists its conversations in, because this is that list holding
                 other rows. It used to be a hand-rolled 288px column at a different padding that could not be
                 dragged at all, which is how two lists of the same cards ended up looking like two components.
                 The scroller inside it carries no padding of its own, deliberately: see RailColumn. -->
            <RailColumn>
                <!-- WHAT NARROWED THIS LIST, and the way out of it. A filtered rail that does not say it is
                     filtered is how a reader concludes the sandbox has only ever run two agents. PINNED above
                     the scroller, where the chat rail keeps the control that narrows it (ChatTabList's filter):
                     what a list is showing must not scroll away from the list. -->
                <RouterLink
                    v-if="focus !== undefined"
                    :to="{ name: `subagents` }"
                    class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                >
                    <Icon name="comments" class="shrink-0 text-2xs" />
                    <span class="min-w-0 flex-1 truncate">{{ focusTitle }}</span>
                    <span class="shrink-0 text-link">Show all</span>
                </RouterLink>
                <div class="scrollbar-thin flex min-h-0 flex-1 flex-col items-stretch gap-3 overflow-y-auto">
                    <template v-for="lane in lanes" :key="lane.label">
                        <!-- The cards go in bare: the lane insets and spaces its own contents, and a wrapper
                             of its own here is how a list starts picking its own padding again. -->
                        <RailLane v-if="lane.rows.length > 0" :label="lane.label" :dot="lane.dot" :count="lane.rows.length">
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
                                <!-- THE CHAT RAIL'S OWN FACTS LINE, to the letter: the model, the age of a
                                     settled row, and the live readout in the corner (the card's `tight` form
                                     puts it there). See `hasFacts` for the four facts that used to be here and
                                     what each of them cost the one the reader came for. -->
                                <template v-if="hasFacts(session)" #meta>
                                    <!-- WHICH MODEL, in the chat rail's slot and clipped to its width: the fact
                                             this list was missing, and the one that decides whether a delegation
                                             is worth reading before you open it. A model it INHERITED from its
                                             parent is drawn no differently (it is what the child is spending)
                                             and says so on hover, which is the honest way round: the row is not
                                             claiming the child chose it. -->
                                    <span
                                        v-if="modelOf(session) !== undefined"
                                        class="max-w-24 truncate"
                                        v-tooltip.top="
                                            modelOf(session)!.inherited ? `Its parent's model: this agent reported none of its own` : undefined
                                        "
                                        >{{ modelOf(session)!.label }}</span
                                    >
                                    <!-- The age keeps to the settled rows: a live one's clock is the live
                                             readout's ticking elapsed, which on this card ends the same line,
                                             and two clocks on one card disagree by construction. Right-aligned,
                                             the chat rail's slot: the "when" of a card has one corner whether or
                                             not the turn has ended. -->
                                    <span v-if="!subagentLive(session) && session.activityAt > 0" class="ml-auto shrink-0">{{
                                        relativeTime(session.activityAt)
                                    }}</span>
                                </template>
                            </RailCard>
                        </RailLane>
                    </template>
                </div>
            </RailColumn>

            <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!-- WHAT IT IS, in the card's own vocabulary (the tile, the title, the status glyph) so the row
                     you pressed and the header you land on read as one agent, and the two ways out of this
                     pane: back to the conversation that started it, and, for a delegation (which unlike a
                     subagent has a process of its own), into the shell it runs in. -->
                <!-- NO RULE UNDER IT. The rail beside it is lane slabs on a card ground and draws not one
                     hairline; a line across the top of the pane put the only border on the surface exactly
                     where the eye lands first, and cut the header off from the transcript it names. Height and
                     the title's weight are what separate them now: the same way the lanes separate the rail. -->
                <div v-if="current" class="flex shrink-0 items-center gap-2.5 px-4 py-2.5 text-2xs text-muted">
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
                    <span
                        v-if="modelOf(current) !== undefined"
                        class="shrink-0"
                        v-tooltip.bottom="modelOf(current)!.inherited ? `Its parent's model: this agent reported none of its own` : undefined"
                        >{{ modelOf(current)!.label }}</span
                    >
                    <Icon v-bind="STATUS[current.status]" class="shrink-0" />
                    <!-- WHETHER THE WORK BELOW SHOWS ITS TOOL CALLS: the chat's own control (the same component
                         the composer's status strip draws), because this is the chat's own transcript with the
                         chat's own folded runs in it, and a reader who hid the calls in one place has said what
                         they want of the other. In the header for the reason it is under the composer over
                         there: it goes wherever the surface's own furniture is, and this pane has a header
                         where a pane has a status strip. -->
                    <ChatToolCallsToggle :class="HEADER_ACTION_BOX" />
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
                <p v-if="current?.error" class="mx-4 shrink-0 whitespace-pre-wrap rounded-md bg-danger/10 px-3 py-2 text-2xs text-danger">
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
                <div ref="pane" class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-3" @scroll.passive="onPaneScroll">
                    <div class="chat-turns">
                        <!-- The two sections' own spacing, set here rather than borrowed from the column's
                             --chat-gap: that gap is the distance between two events INSIDE a transcript, and
                             the distance between the report and the entire transcript is a bigger fact than
                             the distance between one tool call and the next. -->
                        <div class="flex min-w-0 flex-col gap-6">
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
                            <section v-if="report !== undefined" class="flex min-w-0 flex-col gap-2">
                                <span class="text-2xs font-semibold uppercase tracking-wide text-muted">Report</span>
                                <!-- WHETHER ANYTHING CHECKED IT, above the words it qualifies rather than
                                     under them: the reader decides how to read the report, so the standing
                                     has to arrive before the report does, not as a footnote to it. -->
                                <p v-if="current?.verification" class="flex min-w-0 items-baseline gap-1.5 text-2xs">
                                    <Icon
                                        :name="VERIFICATION[current.verification.state].name"
                                        :class="[VERIFICATION[current.verification.state].class, `shrink-0`]"
                                    />
                                    <span :class="[VERIFICATION[current.verification.state].class, `font-semibold`]">
                                        {{ VERIFICATION[current.verification.state].text }}
                                    </span>
                                    <span class="min-w-0 truncate text-muted">{{ verificationDetail(current.verification) }}</span>
                                </p>
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

                            <!-- ITS WORK, IN THE CHAT'S OWN SHAPES, and by now in the chat's own COMPONENTS:
                                 the prompt on the surface a prompt is drawn on, the reasoning in the fold the
                                 conversation folds it into (ChatThinking), the answer on the assistant's own
                                 wash, and the tool calls through the very pair the transcript renders
                                 (ChatToolRows shown, ChatToolRun folded) — children and all, since a child that
                                 itself delegates nests here too. That last one is what this pane was missing:
                                 it drew every call as a card unconditionally, so a reader who had folded the
                                 runs away in chat got a screenful of them here, and one preference quietly
                                 meant two different things on two surfaces.
                                 Its label earns its row only when there is a report above to be told apart
                                 from — heading a pane that holds nothing else is decoration, and this column
                                 has no air to spend on any. -->
                            <section class="flex min-w-0 flex-col gap-1.5">
                                <span v-if="report !== undefined" class="text-2xs font-semibold uppercase tracking-wide text-muted">Work</span>
                                <div class="chat-stack flex min-w-0 flex-col">
                                    <div v-for="(message, index) in messages" :key="index" class="chat-stack flex flex-col">
                                        <!-- The prompt it was given reads as a prompt: the same right-aligned
                                             bubble on the same `.chat-surface` the chat gives the user's own
                                             words, because from the child's side that is what it is. Uncapped,
                                             unlike the conversation's, which clamps to six lines and offers to
                                             open: there is exactly one prompt on this surface and it is the
                                             delegation itself, so the thing the chat's clamp defends (the
                                             answer's room, turn after turn) is not at stake. -->
                                        <p
                                            v-if="message.role === 'user'"
                                            class="chat-surface max-w-[85%] self-end whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed text-content"
                                        >
                                            {{ message.text }}
                                        </p>
                                        <template v-else>
                                            <ChatThinking
                                                v-if="message.thinking"
                                                :thinking="message.thinking"
                                                :streaming="current !== undefined && subagentLive(current)"
                                            />
                                            <!-- <Markdown> brings `md-prose` with it, which is what dresses the
                                                 output: every rule in prose.css hangs off that class, and
                                                 rendered without it the headings, lists, tables and code blocks
                                                 all came out as undifferentiated body text. `chat-markdown` is
                                                 only the transcript's tuning of those tokens, and
                                                 `chat-surface-assistant` the wash the conversation sets an
                                                 answer on. -->
                                            <Markdown
                                                v-if="message.text"
                                                :source="message.text"
                                                :decorate="decorate"
                                                class="chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5"
                                            />
                                            <div v-if="message.tools?.length" class="flex w-full flex-col gap-1">
                                                <ChatToolRows
                                                    v-if="showToolCalls"
                                                    :tools="message.tools"
                                                    :live="current !== undefined && subagentLive(current)"
                                                />
                                                <ChatToolRun v-else :tools="message.tools" :live="current !== undefined && subagentLive(current)" />
                                            </div>
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
