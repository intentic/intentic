import type { AgentSearchResult, MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { Conversation } from "../../chat/session/conversation";
import { useChat } from "../../chat/run/useChat";
import type { ChatSession } from "../../chat/run/useChat-sessions";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useAgents } from "../fleet/useAgents";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { AGENTS, SESSIONS } from "../../../lib/queryKeys";

// Filters the fleet by what was said, as a factory (not a singleton) so each surface owns its own query. Matches in two
// tiers, local per keystroke over open transcripts and titles, debounced daemon for the rest, merged as a union so
// refining a query never empties the board. Match case is shared across every surface since it's a reading habit, not a
// per-search setting; minimum two characters, matching the daemon's own floor.

// What an open conversation said, matchable without asking the daemon: both user and assistant text, folded (whitespace
// collapsed, lowercased unless case-sensitive) once here rather than per test, since the board asks about a card
// roughly seven times per render.
interface SpokenLine {
    // The line as a snippet quotes it: whitespace collapsed, trimmed.
    readonly text: string;
    // As the substring test reads it; the same string as `text` when the case rule is on.
    readonly folded: string;
    readonly speaker: Speaker;
}

const linesOf = (conversation: Conversation, caseSensitive: boolean): readonly SpokenLine[] =>
    conversation.messages.value.flatMap((message) => {
        if (message.role !== `user` && message.role !== `assistant`) {
            return [];
        }
        const text = message.text.replace(/\s+/gu, ` `).trim();
        return [
            {
                text,
                folded: caseSensitive ? text : text.toLowerCase(),
                speaker: message.role === `user` ? (`user` as const) : (`agent` as const),
            },
        ];
    });

// How much of a matched line a card shows, matching the daemon's own SNIPPET_CHARS so a card looks the same from either
// tier.
const SNIPPET_CHARS = 120;

// The user's own words win when both sides match, as the daemon's matchLines does it: a query is typed from memory of
// one's own phrasing.
const snippetFor = (lines: readonly SpokenLine[], needle: string): MatchSnippet | undefined => {
    const said = (speaker: Speaker): MatchSnippet | undefined => {
        for (const spoken of lines) {
            if (spoken.speaker !== speaker) {
                continue;
            }
            const at = spoken.folded.indexOf(needle);
            if (at === -1) {
                continue;
            }
            const line = spoken.text;
            if (line.length <= SNIPPET_CHARS) {
                return { text: line, speaker };
            }
            const centred = Math.round(at + needle.length / 2 - SNIPPET_CHARS / 2);
            const start = Math.max(0, Math.min(line.length - SNIPPET_CHARS, centred));
            const end = start + SNIPPET_CHARS;
            return { text: `${start > 0 ? `…` : ``}${line.slice(start, end)}${end < line.length ? `…` : ``}`, speaker };
        }
        return undefined;
    };
    return said(`user`) ?? said(`agent`);
};

// A match and its evidence; `snippet` is absent when the hit was the title, which the card already shows.
interface AgentHit {
    readonly snippet?: MatchSnippet;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

// The case rule, shared by every filter field and remembered across reloads: written through on change so the ref is
// the preference and no caller has to save it.
const CASE_KEY = `ui-fleet-filter-case`;
const readStoredCase = (): boolean => {
    try {
        return localStorage.getItem(CASE_KEY) === `1`;
    } catch {
        return false;
    }
};
const matchCase = ref(readStoredCase());
watch(matchCase, (value) => {
    try {
        localStorage.setItem(CASE_KEY, value ? `1` : `0`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

export function useAgentFilter() {
    const { reachable } = useSandbox();
    const { archived } = useAgents();

    const query = ref(``);
    // Folded once to whatever case rule is in force, so every tier runs a substring test against a haystack folded the
    // same way.
    const needle = computed(() => (matchCase.value ? query.value.trim() : query.value.trim().toLowerCase()));
    const active = computed(() => needle.value.length >= MIN_QUERY);

    // The daemon tier's input, trailing the typed one so a keystroke burst becomes one request. Watched off `needle`,
    // not `query`, so trimming whitespace doesn't spend a round trip.
    const settled = ref(``);
    let timer: ReturnType<typeof setTimeout> | undefined;
    watch(needle, (value) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            settled.value = value;
        }, DEBOUNCE_MS);
    });
    onScopeDispose(() => clearTimeout(timer));

    const enabled = computed(() => reachable.value && settled.value.length >= MIN_QUERY);

    // Flipping `Aa` re-asks at once rather than debouncing with the text, and rides in the key as well as the URL,
    // since the same words under the other rule cache separately.
    const params = computed(() => `query=${encodeURIComponent(settled.value)}${matchCase.value ? `&caseSensitive=true` : ``}`);

    const fleetSearch = useQuery({
        queryKey: computed(() => AGENTS.of(`search`, params.value)),
        queryFn: ({ signal }) => sandboxJson<AgentSearchResult>(`/agents/search?${params.value}`, { signal }),
        enabled,
        placeholderData: keepPreviousData,
    });

    // The never-carded conversations: sessions no agent entry owns. Fetched here rather than through useChat's
    // loadSessions, which writes the singleton History popover list a board query must not rewrite.
    const sessionSearch = useQuery({
        queryKey: computed(() => SESSIONS.of(`search`, params.value)),
        queryFn: ({ signal }) => sandboxJson<{ sessions: ChatSession[] }>(`/sessions?${params.value}`, { signal }),
        enabled,
        placeholderData: keepPreviousData,
    });

    // The daemon's answer by agent id; empty while the query is too short or the answer is for an older one.
    const remote = computed<ReadonlyMap<string, AgentHit>>(() => {
        if (!enabled.value || settled.value !== needle.value) {
            return new Map();
        }
        return new Map(
            (fleetSearch.data.value?.matches ?? []).map((match) => [match.id, match.snippet === undefined ? {} : { snippet: match.snippet }]),
        );
    });

    // Whether the local+daemon merge is complete, distinct from whether a request is in flight: partial while the
    // daemon hasn't answered for the current query, or has answered but says its own index is still filling.
    const partial = computed(() => {
        if (!active.value) {
            return false;
        }
        if (settled.value !== needle.value || fleetSearch.isFetching.value || sessionSearch.isFetching.value) {
            return true;
        }
        return fleetSearch.data.value?.indexing === true;
    });

    // What this browser can match, indexed once per change rather than re-read per card. Gated on `active` so an empty
    // box costs nothing and a streaming turn doesn't rebuild the index every frame.
    const localLines = computed<ReadonlyMap<string, readonly SpokenLine[]>>(() => {
        if (!active.value) {
            return new Map();
        }
        const caseSensitive = matchCase.value;
        return new Map(
            useChat().conversations.value.map((conversation) => [conversation.conversationId, linesOf(conversation, caseSensitive)]),
        );
    });

    // A hit's identity held across evaluations, since `snippetOf` feeds `v-memo`: a same-content object avoids
    // redrawing every matched card on every roster frame. Keyed by card, not by card-and-title.
    const held = new Map<string, AgentHit>();
    const sameHit = (left: AgentHit, right: AgentHit): boolean =>
        left.snippet === right.snippet ||
        (left.snippet !== undefined &&
            right.snippet !== undefined &&
            left.snippet.text === right.snippet.text &&
            left.snippet.speaker === right.snippet.speaker);
    // One card, addressed by box and id, never id alone: ids are minted per daemon and a wider board can hold two cards
    // sharing one.
    const cardKey = (agent: FleetAgent): string => `${agent.sandboxId ?? ``}/${agent.id}`;

    // A memoising closure re-minted on every reactive change (query, case rule, transcripts, daemon reply), since the
    // board tests every card in a lane several times per render. The title rides in the memo key, being the one input
    // read lazily off the agent handed in, so a rename doesn't keep answering for the old name.
    const finder = computed(() => {
        const on = active.value;
        const term = needle.value;
        const caseSensitive = matchCase.value;
        const index = localLines.value;
        const answered = remote.value;
        const found = new Map<string, AgentHit | undefined>();
        return (agent: FleetAgent): AgentHit | undefined => {
            if (!on) {
                return undefined;
            }
            const card = cardKey(agent);
            const key = `${card}/${agent.title ?? ``}`;
            if (found.has(key)) {
                return found.get(key);
            }
            const title = caseSensitive ? agent.title : agent.title?.toLowerCase();
            const hit = ((): AgentHit | undefined => {
                if (title?.includes(term) === true) {
                    return {};
                }
                const local = snippetFor(index.get(agent.id) ?? [], term);
                return local === undefined ? answered.get(agent.id) : { snippet: local };
            })();
            const previous = hit === undefined ? undefined : held.get(card);
            const reported = previous !== undefined && hit !== undefined && sameHit(previous, hit) ? previous : hit;
            if (reported !== undefined) {
                held.set(card, reported);
            }
            found.set(key, reported);
            return reported;
        };
    });

    const hitOf = (agent: FleetAgent): AgentHit | undefined => finder.value(agent);

    const matches = (agent: FleetAgent): boolean => !active.value || hitOf(agent) !== undefined;
    const snippetOf = (agent: FleetAgent): MatchSnippet | undefined => hitOf(agent)?.snippet;

    // The `Aa` switch itself, one preference so every surface shows the same one.
    const archivedMatches = computed(() => {
        if (!active.value) {
            return [];
        }
        const onBoard = new Set(useAgents().fleet.value.map((agent) => agent.id));
        return archived.value.filter((agent) => !onBoard.has(agent.id) && hitOf(agent) !== undefined);
    });

    // Matches agents off the board, in the archive, since a filter answering "no matches" for something one click away
    // is unforgivable. Excludes anything already lifted back onto the live lanes, to avoid reporting one chat as two
    // results.
    const sessionMatches = computed<readonly ChatSession[]>(() => {
        if (!active.value || settled.value !== needle.value) {
            return [];
        }
        const { fleet } = useAgents();
        const carded = new Set([...fleet.value, ...archived.value].flatMap((agent) => (agent.sessionId === undefined ? [] : [agent.sessionId])));
        return (sessionSearch.data.value?.sessions ?? []).filter((session) => !carded.has(session.id));
    });

    return {
        query,
        needle,
        // Conversations no agent owns; sessions a fleet agent already carries are dropped so one chat isn't reported
        // twice.
        matchCase,
        active,
        matches,
        snippetOf,
        archivedMatches,
        sessionMatches,
        // Whether the daemon has answered for what's currently typed; true during the debounce and while the request is
        // in flight.
        searching: computed(() => active.value && (settled.value !== needle.value || fleetSearch.isFetching.value || sessionSearch.isFetching.value)),
        // ...and that the visible list may not be all of it, said instead of treating a partial answer as the whole
        // fleet.
        partial,
    };
}
