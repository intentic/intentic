<script setup lang="ts">
import { Button, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
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

const marks = (text: string) => markSegments(text, props.needle, props.matchCase);
const ownerOf = (agent: FleetAgent) => sessionMark(agent, user.value?.email, presenceOthers.value);
const standing = (agent: FleetAgent) => {
    const meta = agentStandingMeta(agent);
    return { ...meta, class: cornerInk(meta.class) };
};
// Subheads only when both kinds are listed: with one, the header's count already names it.
const both = (): boolean => props.agents.length > 0 && props.sessions.length > 0;

const ROW = `group relative flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-overlay`;
// The title is the row's press, stretched over the whole row; the row's own presses sit above it (`relative`).
const PRESS = `min-w-0 truncate rounded-sm text-left text-xs font-medium text-content outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60`;
const HIT = `rounded-sm bg-primary-600/30 text-content`;
const SUBHEAD = `px-2.5 pb-1 pt-2 text-2xs font-medium text-subtle`;
</script>

<template>
    <div
        class="flex shrink-0 flex-col border-t border-line bg-card shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]"
        :class="fill ? 'max-h-[75%]' : 'max-h-[50%]'"
        data-beyond
    >
        <div v-if="fill" class="flex h-10 shrink-0 items-center gap-2 px-4 text-xs">
            <Icon name="search" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate font-medium text-content">{{ label }}</span>
        </div>
        <button
            v-else
            type="button"
            class="flex h-10 w-full shrink-0 items-center gap-2 px-4 text-left text-xs transition-colors hover:bg-overlay"
            :aria-expanded="open"
            @click="emit(`toggle`)"
        >
            <Icon name="search" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate font-medium text-content">{{ label }}</span>
            <Icon :name="open ? 'chevron-down' : 'chevron-up'" class="shrink-0 text-2xs text-subtle" />
        </button>
        <div v-if="open" class="flex min-h-0 flex-col overflow-auto px-2 pb-2" :class="narrow ? '' : 'lg:px-3'">
            <section v-if="agents.length > 0" class="flex min-w-0 flex-col">
                <h3 v-if="both()" :class="SUBHEAD">{{ t(`agents.agentsView.inArchive`) }}</h3>
                <ul class="grid min-w-0 gap-x-3" :class="narrow ? '' : 'grid-cols-2'">
                    <li
                        v-for="agent in agents"
                        :key="agent.id"
                        :class="[ROW, ringed(agent.id) ? 'bg-overlay ring-1 ring-primary-500/50' : '', busy(agent) ? 'opacity-60' : '']"
                        @contextmenu.prevent="(event) => emit(`menu`, agent, event)"
                    >
                        <span class="flex h-5 shrink-0 items-center">
                            <Icon
                                :name="standing(agent).icon"
                                v-tooltip.top="standing(agent).label"
                                :aria-label="standing(agent).label"
                                role="img"
                                class="relative text-sm"
                                :class="standing(agent).class"
                            />
                        </span>
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex h-5 min-w-0 items-center gap-2">
                                <button
                                    type="button"
                                    v-tooltip.top.overflow="agentDisplayTitle(agent)"
                                    :class="PRESS"
                                    @click="(event) => emit(`open`, agent, event)"
                                    @dblclick="emit(`changes`, agent)"
                                >
                                    <span v-for="(run, at) in marks(agentDisplayTitle(agent))" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
                                </button>
                                <span class="ml-auto flex shrink-0 items-center gap-2 text-2xs text-subtle">
                                    <OwnerMark v-if="ownerOf(agent) !== undefined" :mark="ownerOf(agent)!" class="relative" />
                                    <span class="tabular-nums"><AgentCardDate :at="agent.updatedAt || (agent.archivedAt ?? 0)" /></span>
                                </span>
                            </div>
                            <MatchLine
                                v-if="snippetOf(agent) !== undefined"
                                :snippet="snippetOf(agent)!"
                                :needle="needle"
                                :match-case="matchCase"
                                class="block truncate text-2xs text-muted"
                            />
                            <span v-else-if="idMatchOf(agent) !== undefined" class="truncate font-mono text-2xs text-muted">
                                <span v-for="(run, at) in markSegments(idMatchOf(agent)!.text, idMatchOf(agent)!.mark)" :key="at" :class="run.hit ? HIT : ''">{{
                                    run.text
                                }}</span>
                            </span>
                        </div>
                        <!-- Repeated down every row, so quiet, and only under the pointer where there is one. -->
                        <Button
                            tier="quiet"
                            size="small"
                            :disabled="busy(agent)"
                            :aria-label="t(`agents.agentCard.restoreAgent`)"
                            v-tooltip.top="t(`agents.agentCard.restoreAgent`)"
                            class="relative shrink-0 self-center"
                            :class="coarse ? '' : 'opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100'"
                            @click.stop="emit(`restore`, agent)"
                        >
                            <template #icon><Icon name="undo" /></template>
                        </Button>
                    </li>
                </ul>
            </section>
            <section v-if="sessions.length > 0" class="flex min-w-0 flex-col">
                <h3 v-if="both()" :class="SUBHEAD">{{ t(`agents.agentsView.inEarlierChats`) }}</h3>
                <!-- Conversations no agent entry owns: no card to draw, so they open as tabs, the act the History menu performs. -->
                <ul class="grid min-w-0 gap-x-3" :class="narrow ? '' : 'grid-cols-2'">
                    <li v-for="session in sessions" :key="session.id" :class="ROW">
                        <span class="flex h-5 shrink-0 items-center"><Icon name="history" class="text-sm text-faint" /></span>
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex h-5 min-w-0 items-center gap-2">
                                <button type="button" v-tooltip.top.overflow="session.title" :class="PRESS" @click="emit(`openSession`, session.id)">
                                    <span v-for="(run, at) in marks(session.title)" :key="at" :class="run.hit ? HIT : ''">{{ run.text }}</span>
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
        </div>
    </div>
</template>
