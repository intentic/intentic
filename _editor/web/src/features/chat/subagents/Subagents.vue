<script setup lang="ts">
import { type AgentProvider, providerLabel, type TranscriptRow, type SubagentSession } from "@intentic/sandbox-contract";
import { Icon, type IconName, Markdown, ui, useDevice } from "@intentic/ui";
import { useQuery } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activityIcon } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { relativeTime } from "../models/catalog";
import { modelLabelFor } from "../accounts/providerCatalog";
import { sessionCategory } from "../../../app/sessionCategory";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { SUBAGENT_TRANSCRIPT } from "../../../lib/queryKeys";
import { subagentLive, useSubagentsQuery } from "./subagentsQuery";
import { CHAT_SURFACE } from "../tools/chatToolSurface";
import { workspaceSurface } from "../panel/workspaceSurface";
import { useToolCalls } from "../tools/useToolCalls";
import ChatThinking from "../transcript/ChatThinking.vue";
import ChatToolCallsToggle from "../tools/ChatToolCallsToggle.vue";
import ChatToolRows from "../tools/ChatToolRows.vue";
import ChatToolRun from "../tools/ChatToolRun.vue";
import ActionLink from "../../../components/ActionLink.vue";
import RailCard from "../../../components/RailCard.vue";
import RailColumn from "../../../components/RailColumn.vue";
import RailLane from "../../../components/RailLane.vue";
import { fileLinkDecorator } from "../../../lib/markdown/renderMarkdown";

// The page for agents this sandbox's agents started, alongside the terminal panel and Browsers area. A
// subagent's only view is its transcript, so this is a column of chat components, not a pane. No
// composer: steering a child goes through its parent (`/children/send`), never directly.

// The transcript is the one thing still polled; the roster itself is pushed.
const TRANSCRIPT_POLL_MS = 4000;

const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { sessions } = useSubagentsQuery();
const { agentById, open: openAgent } = useAgents();
// The chat's own tool-call preference, read here so a child's transcript honors the same setting.
const { showToolCalls } = useToolCalls();

// Which agent's card was clicked, if any; carried as a query, not a route, so 'show all' just drops it.
const focus = computed<string | undefined>(() => (typeof route.query[`agent`] === `string` ? route.query[`agent`] : undefined));
const focusTitle = computed(() => (focus.value === undefined ? undefined : (agentById(focus.value)?.title ?? `this agent`)));
const visible = computed(() =>
    focus.value === undefined ? sessions.value : sessions.value.filter((session) => session.conversationId === focus.value),
);

// The subagent named in the URL; falls back to the first (live-first sorted) when unnamed or gone.
const selected = computed<string | undefined>(() => {
    const named = typeof route.params[`id`] === `string` ? route.params[`id`] : undefined;
    if (named !== undefined && visible.value.some((session) => session.id === named)) {
        return named;
    }
    return visible.value[0]?.id;
});
const current = computed(() => visible.value.find((session) => session.id === selected.value));

// This page's tool surface; paths resolve against the child's parent's tree, where a subagent actually runs.
provide(
    CHAT_SURFACE,
    workspaceSurface({
        agent: () => {
            const conversationId = current.value?.conversationId;
            return conversationId !== undefined && agentById(conversationId)?.branch !== undefined ? conversationId : undefined;
        },
        // A child that itself delegated routes to its own transcript here, rather than reloading.
        navigate: (to) => void router.push(to),
    }),
);

// A route, not a click handler: every row gets an address, and Ctrl/⌘-click opens it beside the list.
const rowTo = (id: string) => ({ name: `subagents`, params: { id }, query: route.query });

// Running rows first, then finished; dots match the chat rail's own (ChatTabList).
const lanes = computed<{ readonly label: string; readonly dot: string; readonly rows: SubagentSession[] }[]>(() => [
    { label: `Running`, dot: `bg-success`, rows: visible.value.filter(subagentLive) },
    { label: `Finished`, dot: `bg-line-strong`, rows: visible.value.filter((session) => !subagentLive(session)) },
]);

// The card's title: the description, falling back to the agent type only when none was given.
const titleOf = (session: SubagentSession): string =>
    [session.description, session.agentType].find((part) => part !== undefined && part !== ``) ?? `Agent ${session.id.slice(-6)}`;

// Opens the parent conversation in the dock on desktop, or navigates to its page on mobile or when the
// roster doesn't have it.
const parentTo = (session: SubagentSession): string => `/agents/${encodeURIComponent(session.conversationId)}`;
const openParent = (session: SubagentSession): void => {
    const parent = agentById(session.conversationId);
    if (parent !== undefined && !mobile.value) {
        openAgent(parent);
        return;
    }
    void router.push(parentTo(session));
};

// An SDK subagent wears its parent's provider (falling back to Claude); a spawned child names its own.
const providerOf = (session: SubagentSession): AgentProvider =>
    session.kind === `subagent` ? (agentById(session.conversationId)?.provider ?? `claude`) : (session.provider ?? `claude`);

// Which model the card shows, in the chat rail's own label; never left blank.
// 1. the child's own model, filed by its spawning call or its meta file.
// 2. the parent's model, inherited when nothing named one for the child (`inherited: true`).
// 3. the provider's own name, when the identity tile shows a category glyph instead of it.
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

// The footer link's own edge: no box, unlike the rail's cards, so it needs its own hover style.
const FOOTER_ACTION = `flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-overlay hover:text-content`;

// The task glyphs, shaped like agentStatusMeta's, so this rail's status slot works the same way.
const STATUS: Record<SubagentSession["status"], { name: IconName; spin?: boolean; class: string; "aria-label": string }> = {
    pending: { name: `clock`, class: `text-xs text-subtle`, "aria-label": `Queued` },
    running: { name: `spinner`, spin: true, class: `text-xs text-link`, "aria-label": `Running` },
    blocked: { name: `question-circle`, class: `text-xs text-warning`, "aria-label": `Needs input` },
    paused: { name: `clock`, class: `text-xs text-warning`, "aria-label": `Paused` },
    completed: { name: `check`, class: `text-xs text-success`, "aria-label": `Completed` },
    failed: { name: `times`, class: `text-xs text-danger`, "aria-label": `Failed` },
    killed: { name: `stop`, class: `text-xs text-subtle`, "aria-label": `Killed` },
};

// Whether the report was ever tested, separate from the status glyph: completed means stopped, not verified.
const VERIFICATION: Record<NonNullable<SubagentSession["verification"]>["state"], { name: IconName; class: string; text: string }> = {
    verified: { name: `check-circle`, class: `text-success`, text: `Verified` },
    unproven: { name: `exclamation-triangle`, class: `text-warning`, text: `Unproven` },
    failing: { name: `exclamation-circle`, class: `text-danger`, text: `Check failed` },
    "no-code": { name: `file`, class: `text-muted`, text: `Changed no code` },
};

// What the verification chip stands on; nothing extra for `no-code`, whose chip already says it all.
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

// The live line: what it's doing and for how long. A pending child gets one too — "Queued · 40s" shows
// the concurrency cap at work.
const liveOf = (session: SubagentSession): { icon: IconName; text: string; since: number } | undefined => {
    if (!subagentLive(session)) {
        return undefined;
    }
    if (session.status === `pending`) {
        return { icon: `clock`, text: `Queued`, since: session.startedAt };
    }
    // A blocked child shows what it's waiting on, in its own words (`summary`), not just 'Needs input'.
    if (session.status === `blocked`) {
        return { icon: `question-circle`, text: session.summary ?? `Needs input`, since: session.startedAt };
    }
    return { icon: activityIcon(session.lastTool), text: session.lastTool ?? `Working…`, since: session.startedAt };
};

// Whether the facts line has anything to show, so a `v-if` doesn't draw an empty strip. Now only the
// model, a settled row's age, and the live readout.
const hasFacts = (session: SubagentSession): boolean => modelOf(session) !== undefined || (!subagentLive(session) && session.activityAt > 0);

// One shared timer ticks every live row's elapsed time together.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

// Polled while the child runs, read once when it's finished; the daemon serves a live one from the
// parent's frame log, a settled one from storage.
const transcript = useQuery({
    queryKey: computed(() => SUBAGENT_TRANSCRIPT.of(selected.value ?? ``)),
    enabled: computed(() => selected.value !== undefined),
    refetchInterval: computed(() => (current.value !== undefined && subagentLive(current.value) ? TRANSCRIPT_POLL_MS : false)),
    queryFn: async (): Promise<TranscriptRow[]> => {
        const id = selected.value;
        if (id === undefined) {
            return [];
        }
        const body = (await sandboxJson(`/system/subagents/${encodeURIComponent(id)}/transcript`)) as { messages?: TranscriptRow[] };
        return body.messages ?? [];
    },
});
const messages = computed<TranscriptRow[]>(() => transcript.data.value ?? []);

// Built once, not per render, so a new decorator doesn't re-parse every message on each frame.
const decorate = fileLinkDecorator();

// The report, distinct from the error: a delegation's error is its last output, already shown in the header.
const report = computed<string | undefined>(() => {
    const summary = current.value?.summary;
    return summary !== undefined && summary !== current.value?.error ? summary : undefined;
});

// The report clamps inside the transcript's own scroller, with a fade and toggle, not a separate scrollbox.
const reportExpanded = ref(false);
// Nullable: Vue clears a template ref to `null` both when the element is absent and on unmount.
const reportBox = ref<HTMLElement | null>(null);
const reportOverflows = ref(false);
const reportClamped = computed(() => !reportExpanded.value);
// Stays visible once expanded, so collapsing back to short form is still possible.
const reportToggle = computed(() => reportExpanded.value || reportOverflows.value);
const measureReport = (): void => {
    const el = reportBox.value;
    reportOverflows.value = el !== null && el.scrollHeight > el.clientHeight + 1;
};
// Observes the content too, since the clamped box's height is pinned and would not otherwise signal growth.
// `flush: post` measures the box after its own re-render, not the old document's height.
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

// Follows rather than forces: a reader at the foot stays pinned as new lines arrive; one scrolled up
// stays put.
// Nullable, not optional: Vue clears a template ref to `null` on unmount, and a queued frame may land after.
const pane = ref<HTMLElement | null>(null);
// Slack so the last line's descenders or rounding never register as 'scrolled away'.
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
// A different child resets the clamp and landing spot immediately, the same way the first child is picked.
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
    <!--
        On the card ground (ChatPanel's), not the route's default canvas, since the rail list is copied from
        the floating chat and must read the same way.
    -->
    <!-- Clips to this surface; an overgrown block used to paint past the card ground and over the shell. -->
    <div class="lane-ground-card flex h-full min-h-0 overflow-hidden bg-card">
        <!--
            Not an error: most turns start no agent. Distinct message when filtered to one agent, since "no
            agents started" would contradict the chip just clicked.
        -->
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
            <!-- The chat rail's own column: lane slabs of session cards, read the same way as agents you started. -->
            <!--
                The same width, gutter and drag as the floating chat's rail — this list holds other rows of it, not a
                copy.
            -->
            <RailColumn>
                <!--
                    What narrowed this list, and the way out, pinned above the scroller like the chat rail's own
                    filter.
                -->
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
                        <!-- Cards go in bare; the lane insets and spaces its own contents. -->
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
                                <!--
                                    The chat rail's own facts line: model, a settled row's age, and the live readout.
                                    See `hasFacts` for
                                    what it dropped.
                                -->
                                <template v-if="hasFacts(session)" #meta>
                                    <!--
                                        Clipped to the rail's width; an inherited model says so on hover rather than
                                        claiming the child chose it.
                                    -->
                                    <span
                                        v-if="modelOf(session) !== undefined"
                                        class="max-w-24 truncate"
                                        v-tooltip.top="
                                            modelOf(session)!.inherited ? `Its parent's model: nothing named one for this agent` : undefined
                                        "
                                        >{{ modelOf(session)!.label }}</span
                                    >
                                    <!--
                                        Settled rows only: a live row's clock is the live readout's own ticking
                                        elapsed.
                                    -->
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
                <!--
                    Plain text, distinct from the report below (the same output, said once); its own tinted panel
                    rather
                    than rules.
                -->
                <p v-if="current?.error" class="mx-4 mt-3 shrink-0 whitespace-pre-wrap rounded-md bg-danger/10 px-3 py-2 text-2xs text-danger">
                    {{ current.error }}
                </p>

                <!--
                    One scroller for the report and the work below it, told apart by a label and air rather than a
                    rule,
                    so nothing seams-breaks between them.
                -->
                <div ref="pane" class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-3" @scroll.passive="onPaneScroll">
                    <div class="chat-turns">
                        <!-- Its own spacing: the report-to-transcript gap is bigger than the gap between two turns. -->
                        <div class="flex min-w-0 flex-col gap-6">
                            <!--
                                Rendered through the chat's markdown, not raw text, and clamped rather than boxed so it
                                can't push
                                the work off-screen. A failure is the header's glyph's job, not repeated here.
                            -->
                            <section v-if="report !== undefined" class="flex min-w-0 flex-col gap-2">
                                <span class="text-2xs font-semibold uppercase tracking-wide text-muted">Report</span>
                                <!--
                                    The check's standing sits above the report, so the reader knows how to read it
                                    before starting.
                                -->
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
                                <!--
                                    The ceiling is a share of the viewport (60vh), not a fixed height, so it scales
                                    with the window
                                    instead of over- or under-cutting the report.
                                -->
                                <div ref="reportBox" class="relative" :class="reportClamped ? `max-h-[60vh] overflow-hidden` : undefined">
                                    <Markdown :source="report" :decorate="decorate" class="chat-markdown chat-markdown-compact" />
                                    <!--
                                        The fade signals there's more; a hard cut mid-heading read as a rendering
                                        fault.
                                    -->
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

                            <!--
                                The child's turns in the chat's own components (ChatThinking, ChatToolRows/Run),
                                including nested
                                children. The label only shows when a report sits above it to be told apart from.
                            -->
                            <section class="flex min-w-0 flex-col gap-1.5">
                                <span v-if="report !== undefined" class="text-2xs font-semibold uppercase tracking-wide text-muted">Work</span>
                                <div class="chat-stack flex min-w-0 flex-col">
                                    <div v-for="(message, index) in messages" :key="index" class="chat-stack flex flex-col">
                                        <!--
                                            The same bubble the chat gives the user's words. Uncapped, unlike the
                                            conversation's: there is
                                            exactly one prompt here.
                                        -->
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
                                            <!--
                                                `md-prose` carries prose.css's rules; without it headings, lists and
                                                code render as plain body text.
                                            -->
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
                                    <!--
                                        A running child streams from its parent's turn, so empty here means "nothing
                                        yet", not "nothing coming".
                                    -->
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

                <!--
                    The pane's controls, under the column like the chat's composer status row: only what's actionable,
                    tool-call visibility and the way back to the parent.
                -->
                <div v-if="current" class="flex shrink-0 items-center justify-center gap-3 px-3 pb-2 pt-1 text-2xs text-subtle">
                    <!-- The chat's own control: hiding calls in one place expresses the same wish for the other. -->
                    <ChatToolCallsToggle />
                    <!--
                        A control and an address: plain click docks the parent conversation, Ctrl/⌘-click opens its own
                        tab.
                    -->
                    <ActionLink
                        :to="parentTo(current)"
                        :class="FOOTER_ACTION"
                        v-tooltip.top="`Open the conversation that started this agent`"
                        @activate="openParent(current)"
                    >
                        <Icon name="comments" class="text-2xs" />Parent
                    </ActionLink>
                </div>
            </div>
        </template>
    </div>
</template>
