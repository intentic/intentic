<script setup lang="ts">
import { Button, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import type { MatchSnippet } from "@intentic/sandbox-contract/schemas/agent-search";
import { useAuth } from "../../../client/auth/useAuth";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import MatchLine from "../../../components/MatchLine.vue";
import OwnerMark from "./session/OwnerMark.vue";
import { markSegments } from "../../../lib/markSegments";
import { sessionMark } from "../../../models/agent-status/ownership";
import { agentDisplayTitle, agentStandingMeta, cornerInk } from "../../../models/agent-status/agentStatus-meta";
import { sandboxNow } from "../../../models/agent-status/sandboxClock";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import type { ChatSession } from "../../../models/conversations/run/useChat-sessions";
import type { IdMatch } from "./idMatch";
import { byDay, newestFirst } from "./beyondDays";

// What the board's filter found OFF the board, docked under the lanes: the archive's hits and conversations no agent
// carries. A search result list, not a second board, read as an agenda: one column, newest first, each calendar day
// named once beside its rows (beyondDays.ts), so the order reads top to bottom and no row repeats a date. A row is what
// to recognise a hit by (its standing, its title, whose) and the line saying why it matched. Model, branch, diff and
// parent are what the agent's page is for; on every row of a hundred hits they buried the one fact the reader came for.
// Archived agents and earlier chats share the timeline, told apart by their glyph: the reader is after a conversation
// they remember, not after which store kept it. Opaque, so it reads over any wallpaper.

const props = defineProps<{
    agents: readonly FleetAgent[];
    sessions: readonly ChatSession[];
    // The counts, as one line: the header the panel folds under.
    label: string;
    open: boolean;
    // Nothing on the board matched: the list may take most of the height and stays open, with nothing to fold.
    fill: boolean;
    // Each day in a gutter beside its rows where the board is wide enough, as a heading over them on a narrow board.
    narrow: boolean;
    needle: string;
    matchCase: boolean;
    snippetOf: (agent: FleetAgent) => MatchSnippet | undefined;
    idMatchOf: (agent: FleetAgent) => IdMatch | undefined;
    // The row whose chat is on screen is marked as the open one.
    ringed: (id: string) => boolean;
    busy: (agent: FleetAgent) => boolean;
}>();
const emit = defineEmits<{
    toggle: [];
    open: [agent: FleetAgent, event: MouseEvent];
    changes: [agent: FleetAgent];
    restore: [agent: FleetAgent];
    menu: [agent: FleetAgent, event: MouseEvent];
    openSession: [id: string];
}>();

const t = useT();
const { coarse } = useDevice();
const { user } = useAuth();
// Only the day names follow it ("Today" turning into "Yesterday" at midnight), never what the rows hold.
const now = useNow(true, 60_000);

// A page at a time. Drawn whole, a broad query ("test") put 1,733 rows and 35,000 nodes on screen in one 4-second task;
// the reader scans the first screenful and refines the words, so the rest waits behind one press. A new query starts
// over at one page.
const PAGE = 40;
const shown = ref(PAGE);
watch(
    () => [props.needle, props.matchCase],
    () => {
        shown.value = PAGE;
    },
);

// Both kinds on one clock, newest first: what is sorted is only an id, a time and the item, so a query with a thousand
// hits sorts cheaply and only the page on screen is read for its facts.
const found = computed(() =>
    newestFirst([
        ...props.agents.map((agent) => ({ kind: `agent` as const, at: agent.updatedAt || (agent.archivedAt ?? 0), agent })),
        ...props.sessions.map((session) => ({ kind: `session` as const, at: session.updatedAt, session })),
    ]),
);
const marks = (text: string) => markSegments(text, props.needle, props.matchCase);
// Every fact a row draws, read once per row rather than once per binding, and only for the rows on screen.
const rows = computed(() =>
    found.value.slice(0, shown.value).map((hit) => {
        if (hit.kind === `session`) {
            const { session } = hit;
            return { ...hit, key: `session:${session.id}`, title: session.title, titleRuns: marks(session.title), snippet: session.snippet };
        }
        const { agent } = hit;
        const meta = agentStandingMeta(agent);
        const title = agentDisplayTitle(agent);
        const id = props.idMatchOf(agent);
        return {
            ...hit,
            key: agent.id,
            title,
            titleRuns: marks(title),
            standing: { ...meta, class: cornerInk(meta.class) },
            owner: sessionMark(agent, user.value?.email, presenceOthers.value),
            snippet: props.snippetOf(agent),
            idRuns: id === undefined ? undefined : markSegments(id.text, id.mark),
            ringed: props.ringed(agent.id),
            busy: props.busy(agent),
        };
    }),
);
const days = computed(() => byDay(rows.value, sandboxNow(now.value)));
const hidden = computed(() => Math.max(0, found.value.length - shown.value));
const restoreLabel = computed(() => t(`agents.agentCard.restoreAgent`));
const earlierChat = computed(() => t(`agents.beyondResults.earlierChat`));
// The restore press is mounted only on the row under the pointer or holding focus (every row on touch): a kit Button with
// its tooltip and ripple on each of forty rows was the largest share of drawing a page, for a press nobody sees at rest.
// Its seat is always there and the press floats in it, so nothing on the row moves when it appears.
const live = ref<string>();
const pressable = (id: string): boolean => coarse.value || live.value === id;

// A day: its name in a gutter where the board is wide (pinned while its rows scroll past), over its rows where narrow.
const DAY = `grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-2 border-t border-line py-1.5 first:border-t-0`;
const GUTTER = `sticky top-0 flex flex-col self-start px-2.5 py-1 leading-4`;
const HEADING = `sticky top-0 z-10 flex items-baseline gap-1.5 bg-card px-2.5 pb-1 pt-3`;
// Two pixels between rows, so the open row's wash and the hovered row's never touch.
const ROW = `group relative flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-1 transition-colors`;
// The open row: a wash and a bar at its edge, instead of a ring that read as one more hover. Stronger than Light's own
// hover, which is the accent at 8%, so the two never read as one state.
const OPEN = `bg-primary-600/15 before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary-500`;
// The title is the row's press, stretched over the whole row; the row's own presses sit above it (`relative`).
const PRESS = `min-w-0 truncate rounded-sm text-left text-xs font-medium text-content outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60`;
const HIT = `rounded-sm bg-primary-600/30 text-content`;
const WHY = `block truncate pb-0.5 text-2xs leading-4 text-muted`;
// The bar the panel folds into: one slim line under the lanes.
const BAR = `flex h-8 w-full shrink-0 items-center gap-2 px-4 text-left text-2xs`;
</script>

<template>
    <div
        class="flex shrink-0 flex-col border-t border-line bg-card shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]"
        :class="fill ? 'max-h-[75%]' : 'max-h-[50%]'"
        data-beyond
    >
        <div v-if="fill" :class="BAR">
            <Icon name="search" class="shrink-0 text-subtle" />
            <span class="min-w-0 flex-1 truncate font-medium text-content">{{ label }}</span>
        </div>
        <button v-else type="button" :class="[BAR, 'transition-colors hover:bg-overlay']" :aria-expanded="open" @click="emit(`toggle`)">
            <Icon name="search" class="shrink-0 text-subtle" />
            <span class="min-w-0 flex-1 truncate font-medium text-content">{{ label }}</span>
            <Icon :name="open ? 'chevron-down' : 'chevron-up'" class="shrink-0 text-subtle" />
        </button>
        <div v-if="open" class="flex min-h-0 flex-col overflow-auto border-t border-line px-2 pb-2" :class="narrow ? '' : 'lg:px-3'">
            <section v-for="day in days" :key="day.key" :class="narrow ? 'flex min-w-0 shrink-0 flex-col' : DAY" data-day>
                <h3 :class="narrow ? HEADING : GUTTER">
                    <span class="text-xs font-medium text-content">{{ day.head }}</span>
                    <span class="text-2xs tabular-nums text-subtle">{{ day.date }}</span>
                </h3>
                <ul class="flex min-w-0 flex-col gap-0.5">
                    <template v-for="row in day.rows" :key="row.key">
                        <li
                            v-if="row.kind === `agent`"
                            :class="[ROW, row.ringed ? OPEN : 'hover:bg-overlay', row.busy ? 'opacity-60' : '']"
                            @contextmenu.prevent="(event) => emit(`menu`, row.agent, event)"
                            @pointerenter="live = row.key"
                            @focusin="live = row.key"
                        >
                            <span class="flex h-6 shrink-0 items-center">
                                <Icon
                                    :name="row.standing.icon"
                                    v-tooltip.top="row.standing.label"
                                    :aria-label="row.standing.label"
                                    role="img"
                                    class="relative text-sm"
                                    :class="row.standing.class"
                                />
                            </span>
                            <div class="flex min-w-0 flex-1 flex-col">
                                <div class="flex h-6 min-w-0 items-center gap-2">
                                    <button
                                        type="button"
                                        v-tooltip.top.overflow="row.title"
                                        :class="PRESS"
                                        @click="(event) => emit(`open`, row.agent, event)"
                                        @dblclick="emit(`changes`, row.agent)"
                                    >
                                        <span v-for="(run, at) in row.titleRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                    </button>
                                    <OwnerMark v-if="row.owner !== undefined" :mark="row.owner" class="relative ml-auto shrink-0 text-2xs text-subtle" />
                                </div>
                                <MatchLine v-if="row.snippet !== undefined" :snippet="row.snippet" :needle="needle" :match-case="matchCase" :class="WHY" />
                                <span v-else-if="row.idRuns !== undefined" :class="[WHY, 'font-mono']">
                                    <span v-for="(run, at) in row.idRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                </span>
                            </div>
                            <!-- Repeated down every row, so quiet, and only under the pointer where there is one. -->
                            <span class="relative flex size-6 shrink-0 items-center justify-center">
                                <Button
                                    v-if="pressable(row.key)"
                                    tier="quiet"
                                    size="small"
                                    :disabled="row.busy"
                                    :aria-label="restoreLabel"
                                    v-tooltip.top="restoreLabel"
                                    class="absolute"
                                    @click.stop="emit(`restore`, row.agent)"
                                >
                                    <template #icon><Icon name="undo" /></template>
                                </Button>
                            </span>
                        </li>
                        <!-- Conversations no agent entry owns: no card to draw, so they open as tabs, the act the History menu performs. -->
                        <li v-else :class="[ROW, 'hover:bg-overlay']">
                            <span class="flex h-6 shrink-0 items-center">
                                <Icon name="history" v-tooltip.top="earlierChat" :aria-label="earlierChat" role="img" class="relative text-sm text-faint" />
                            </span>
                            <div class="flex min-w-0 flex-1 flex-col">
                                <div class="flex h-6 min-w-0 items-center">
                                    <button type="button" v-tooltip.top.overflow="row.title" :class="PRESS" @click="emit(`openSession`, row.session.id)">
                                        <span v-for="(run, at) in row.titleRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                    </button>
                                </div>
                                <MatchLine v-if="row.snippet !== undefined" :snippet="row.snippet" :needle="needle" :match-case="matchCase" :class="WHY" />
                            </div>
                            <!-- The restore press's seat, so every row's right edge holds. -->
                            <span class="size-6 shrink-0" aria-hidden="true"></span>
                        </li>
                    </template>
                </ul>
            </section>
            <!-- One-way, as the archive's own tail is: folding back would lose the reader's place mid-search. -->
            <Button v-if="hidden > 0" tier="quiet" size="small" class="mt-1 shrink-0 self-center" @click="shown += PAGE">
                <Icon name="chevron-down" />{{ t(`agents.beyondResults.showMore`, { count: Math.min(PAGE, hidden), hidden }) }}
            </Button>
        </div>
    </div>
</template>
