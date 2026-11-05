<script setup lang="ts">
import { Button, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import type { MatchSnippet } from "@intentic/sandbox-contract/schemas/agent-search";
import { useAuth } from "../../../client/auth/useAuth";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import MatchLine from "../../../components/MatchLine.vue";
import AgentCardDate from "../../../parts/fleet/AgentCardDate.vue";
import OwnerMark from "./session/OwnerMark.vue";
import { markSegments } from "../../../lib/markSegments";
import { sessionMark } from "../../../models/agent-status/ownership";
import { agentDisplayTitle, agentStandingMeta, cornerInk } from "../../../models/agent-status/agentStatus-meta";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import type { ChatSession } from "../../../models/conversations/run/useChat-sessions";
import type { IdMatch } from "./idMatch";

// What the board's filter found OFF the board, docked under the lanes: the archive's hits and conversations no agent
// carries. A search result list, not a second board: one line to recognise each by (its standing, its title, whose,
// when) and one line saying why it matched. Model, branch, diff and parent are what the agent's page is for; on every
// row of a hundred hits they buried the one fact the reader came for. Opaque, so it reads over any wallpaper.

const props = defineProps<{
    agents: readonly FleetAgent[];
    sessions: readonly ChatSession[];
    // The counts, as one line: the header the panel folds under.
    label: string;
    open: boolean;
    // Nothing on the board matched: the list may take most of the height and stays open, with nothing to fold.
    fill: boolean;
    // Two columns of rows where the board is wide enough, one on a narrow board.
    narrow: boolean;
    needle: string;
    matchCase: boolean;
    snippetOf: (agent: FleetAgent) => MatchSnippet | undefined;
    idMatchOf: (agent: FleetAgent) => IdMatch | undefined;
    // The row whose chat is on screen wears the ring a card would.
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

const marks = (text: string) => markSegments(text, props.needle, props.matchCase);
// Every fact a row draws, read once per row rather than once per binding, and only for the rows on screen.
const agentRows = computed(() =>
    props.agents.slice(0, shown.value).map((agent) => {
        const meta = agentStandingMeta(agent);
        const title = agentDisplayTitle(agent);
        const id = props.idMatchOf(agent);
        return {
            agent,
            title,
            titleRuns: marks(title),
            standing: { ...meta, class: cornerInk(meta.class) },
            owner: sessionMark(agent, user.value?.email, presenceOthers.value),
            at: agent.updatedAt || (agent.archivedAt ?? 0),
            snippet: props.snippetOf(agent),
            idRuns: id === undefined ? undefined : markSegments(id.text, id.mark),
            ringed: props.ringed(agent.id),
            busy: props.busy(agent),
        };
    }),
);
const sessionRows = computed(() =>
    props.sessions.slice(0, Math.max(0, shown.value - props.agents.length)).map((session) => ({ session, titleRuns: marks(session.title) })),
);
const hidden = computed(() => Math.max(0, props.agents.length + props.sessions.length - shown.value));
// Subheads only when both kinds are listed: with one, the header's count already names it.
const both = computed(() => agentRows.value.length > 0 && sessionRows.value.length > 0);
const restoreLabel = computed(() => t(`agents.agentCard.restoreAgent`));
// The restore press is mounted only on the row under the pointer or holding focus (every row on touch): a kit Button with
// its tooltip and ripple on each of forty rows was the largest share of drawing a page, for a press nobody sees at rest.
const live = ref<string>();
const pressable = (id: string): boolean => coarse.value || live.value === id;

const ROW = `group relative flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-overlay`;
// The title is the row's press, stretched over the whole row; the row's own presses sit above it (`relative`).
const PRESS = `min-w-0 truncate rounded-sm text-left text-xs font-medium text-content outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60`;
const HIT = `rounded-sm bg-primary-600/30 text-content`;
const SUBHEAD = `px-2.5 pb-1 pt-2 text-2xs font-medium text-subtle`;
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
        <div v-if="open" class="flex min-h-0 flex-col overflow-auto px-2 pb-2" :class="narrow ? '' : 'lg:px-3'">
            <section v-if="agentRows.length > 0" class="flex min-w-0 shrink-0 flex-col">
                <h3 v-if="both" :class="SUBHEAD">{{ t(`agents.agentsView.inArchive`) }}</h3>
                <ul class="grid min-w-0 gap-x-3" :class="narrow ? '' : 'grid-cols-2'">
                    <li
                        v-for="row in agentRows"
                        :key="row.agent.id"
                        :class="[ROW, row.ringed ? 'bg-overlay ring-1 ring-primary-500/50' : '', row.busy ? 'opacity-60' : '']"
                        @contextmenu.prevent="(event) => emit(`menu`, row.agent, event)"
                        @pointerenter="live = row.agent.id"
                        @focusin="live = row.agent.id"
                    >
                        <span class="flex h-5 shrink-0 items-center">
                            <Icon
                                :name="row.standing.icon"
                                v-tooltip.top="row.standing.label"
                                :aria-label="row.standing.label"
                                role="img"
                                class="relative text-sm"
                                :class="row.standing.class"
                            />
                        </span>
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex h-5 min-w-0 items-center gap-2">
                                <button
                                    type="button"
                                    v-tooltip.top.overflow="row.title"
                                    :class="PRESS"
                                    @click="(event) => emit(`open`, row.agent, event)"
                                    @dblclick="emit(`changes`, row.agent)"
                                >
                                    <span v-for="(run, at) in row.titleRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                </button>
                                <span class="ml-auto flex shrink-0 items-center gap-2 text-2xs text-subtle">
                                    <OwnerMark v-if="row.owner !== undefined" :mark="row.owner" class="relative" />
                                    <span class="tabular-nums"><AgentCardDate :at="row.at" /></span>
                                </span>
                            </div>
                            <MatchLine
                                v-if="row.snippet !== undefined"
                                :snippet="row.snippet"
                                :needle="needle"
                                :match-case="matchCase"
                                class="block truncate text-2xs text-muted"
                            />
                            <span v-else-if="row.idRuns !== undefined" class="truncate font-mono text-2xs text-muted">
                                <span v-for="(run, at) in row.idRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                            </span>
                        </div>
                        <!-- Repeated down every row, so quiet, and only under the pointer where there is one; its seat stays, so the time column holds. -->
                        <Button
                            v-if="pressable(row.agent.id)"
                            tier="quiet"
                            size="small"
                            :disabled="row.busy"
                            :aria-label="restoreLabel"
                            v-tooltip.top="restoreLabel"
                            class="relative shrink-0 self-center"
                            @click.stop="emit(`restore`, row.agent)"
                        >
                            <template #icon><Icon name="undo" /></template>
                        </Button>
                        <span v-else class="w-7 shrink-0" aria-hidden="true"></span>
                    </li>
                </ul>
            </section>
            <section v-if="sessionRows.length > 0" class="flex min-w-0 shrink-0 flex-col">
                <h3 v-if="both" :class="SUBHEAD">{{ t(`agents.agentsView.inEarlierChats`) }}</h3>
                <!-- Conversations no agent entry owns: no card to draw, so they open as tabs, the act the History menu performs. -->
                <ul class="grid min-w-0 gap-x-3" :class="narrow ? '' : 'grid-cols-2'">
                    <li v-for="{ session, titleRuns } in sessionRows" :key="session.id" :class="ROW">
                        <span class="flex h-5 shrink-0 items-center"><Icon name="history" class="text-sm text-faint" /></span>
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex h-5 min-w-0 items-center gap-2">
                                <button type="button" v-tooltip.top.overflow="session.title" :class="PRESS" @click="emit(`openSession`, session.id)">
                                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                </button>
                                <span class="ml-auto shrink-0 text-2xs tabular-nums text-subtle"><AgentCardDate :at="session.updatedAt" /></span>
                            </div>
                            <MatchLine
                                v-if="session.snippet !== undefined"
                                :snippet="session.snippet"
                                :needle="needle"
                                :match-case="matchCase"
                                class="block truncate text-2xs text-muted"
                            />
                        </div>
                        <!-- The restore press's seat, so every row's time keeps one column. -->
                        <span class="w-7 shrink-0" aria-hidden="true"></span>
                    </li>
                </ul>
            </section>
            <!-- One-way, as the archive's own tail is: folding back would lose the reader's place mid-search. -->
            <Button v-if="hidden > 0" tier="quiet" size="small" class="mt-1 shrink-0 self-center" @click="shown += PAGE">
                <Icon name="chevron-down" />{{ t(`agents.beyondResults.showMore`, { count: Math.min(PAGE, hidden), hidden }) }}
            </Button>
        </div>
    </div>
</template>
