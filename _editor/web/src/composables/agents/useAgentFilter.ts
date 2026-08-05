import type { AgentSearchResult } from "@intentic/sandbox-contract";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, onScopeDispose, ref, watch } from "vue";
import { type ChatSession, useChat } from "../chat/useChat";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey, useSandbox } from "../sandbox/useSandbox";
import { type FleetAgent, useAgents } from "./useAgents";

/* Filter the fleet by what the USER wrote — the board's header field and the popped-out rail's.
 *
 * A FACTORY, not a singleton. The query is how ONE surface is being looked at right now, exactly like the
 * board's showAllFinished / archiveOpen, and the rail lives in a different WINDOW: a filter typed on the board
 * silently narrowing a pop-out the user isn't looking at would be a spooky action at a distance. Each caller
 * owns its own.
 *
 * MATCHING RUNS IN TWO TIERS, because the two things the user needs from a filter are in tension:
 *
 *   1. LOCAL, on every keystroke, no round trip. The card's title IS the user's sanitized first prompt, and
 *      for a conversation this browser has open the whole transcript is already in memory. That covers the
 *      common case ("I remember roughly how I opened it") with the responsiveness a filter has to have to be
 *      typed into at all.
 *   2. DAEMON, debounced. Everything the browser does not hold: the later prompts of agents this tab never
 *      opened, and every archived agent. Merges in when it lands.
 *
 * They are a union, never a replacement — the local tier keeps answering while the daemon one is in flight,
 * so refining a query never flashes the board empty. The daemon tier is the useWorkspaceSearch pattern
 * verbatim (TanStack, keepPreviousData, the abort signal threaded through) so a superseded query is cancelled
 * daemon-side instead of piling up behind the one the user is still typing.
 *
 * The MINIMUM is two characters, matching the daemon's own floor: below that every agent matches and the
 * filter is pure cost. One typed character therefore leaves the board alone rather than emptying it.
 */

// Which prompts of an OPEN conversation this browser can match without asking the daemon. Only what the user
// said: the agent's replies and its tool output name nearly every identifier in the workspace, so matching
// those returns most of the board (see AgentSearchQuerySchema for the same reasoning daemon-side).
const localPromptsOf = (id: string): readonly string[] => {
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    if (conversation === undefined) {
        return [];
    }
    return conversation.messages.value.filter((message) => message.role === `user`).map((message) => message.text);
};

// How much of a matched prompt a card shows — the daemon's own SNIPPET_CHARS, applied to the local tier so a
// card looks the same whichever tier found it.
const SNIPPET_CHARS = 120;

const snippetFor = (prompts: readonly string[], needle: string): string | undefined => {
    for (const prompt of prompts) {
        const line = prompt.replace(/\s+/gu, ` `).trim();
        const at = line.toLowerCase().indexOf(needle);
        if (at === -1) {
            continue;
        }
        if (line.length <= SNIPPET_CHARS) {
            return line;
        }
        const centred = Math.round(at + needle.length / 2 - SNIPPET_CHARS / 2);
        const start = Math.max(0, Math.min(line.length - SNIPPET_CHARS, centred));
        const end = start + SNIPPET_CHARS;
        return `${start > 0 ? `…` : ``}${line.slice(start, end)}${end < line.length ? `…` : ``}`;
    }
    return undefined;
};

// A match, and the evidence for it. `snippet` is absent when the hit was the TITLE — the card already shows
// that, and a line repeating the heading above it is noise where evidence was wanted.
interface AgentHit {
    readonly snippet?: string;
}

/* Split a line into alternating plain / hit runs, so a template can mark the term without v-html — this text
 * is a user's own prompt and an agent's own title, neither of which is trusted markup.
 *
 * Every occurrence, not just the first: a snippet is windowed around one hit but usually catches its
 * neighbours, and marking one of three identical words reads as a rendering bug. Returns a single plain run
 * when there is nothing to mark, which is also what the unfiltered case renders.
 */
export const markSegments = (text: string, needle: string): readonly { text: string; hit: boolean }[] => {
    if (needle.length === 0) {
        return [{ text, hit: false }];
    }
    const haystack = text.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (;;) {
        const found = haystack.indexOf(needle, at);
        if (found === -1) {
            break;
        }
        if (found > at) {
            out.push({ text: text.slice(at, found), hit: false });
        }
        out.push({ text: text.slice(found, found + needle.length), hit: true });
        at = found + needle.length;
    }
    if (at < text.length) {
        out.push({ text: text.slice(at), hit: false });
    }
    return out.length === 0 ? [{ text, hit: false }] : out;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

export function useAgentFilter() {
    const { reachable } = useSandbox();
    const { archived } = useAgents();

    const query = ref(``);
    const needle = computed(() => query.value.trim().toLowerCase());
    const active = computed(() => needle.value.length >= MIN_QUERY);

    // The daemon tier's input, trailing the typed one so a keystroke burst becomes one request. Watched off
    // `needle`, not `query`: leading or trailing whitespace is not a new search, and re-keying the query on it
    // would spend a round trip on a space bar. The pending timer dies with the surface's effect scope.
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

    const fleetSearch = useQuery({
        queryKey: computed(() => sandboxKey(`agents`, `search`, settled.value)),
        queryFn: ({ signal }) => sandboxJson<AgentSearchResult>(`/agents/search?query=${encodeURIComponent(settled.value)}`, { signal }),
        enabled,
        placeholderData: keepPreviousData,
    });

    /* The never-carded conversations: sessions in this workspace that no agent entry owns — a plain chat, or an
     * agent whose registry entry is long gone. Fetched here rather than through useChat's `loadSessions`,
     * which writes the singleton list the History popover renders: a query typed on the board must not rewrite
     * what a popover in another corner of the app is showing.
     */
    const sessionSearch = useQuery({
        queryKey: computed(() => sandboxKey(`sessions`, `search`, settled.value)),
        queryFn: ({ signal }) => sandboxJson<{ sessions: ChatSession[] }>(`/sessions?query=${encodeURIComponent(settled.value)}`, { signal }),
        enabled,
        placeholderData: keepPreviousData,
    });

    // The daemon's answer, by agent id. Empty while the query is too short or the answer is for an older one.
    const remote = computed<ReadonlyMap<string, AgentHit>>(() => {
        if (!enabled.value || settled.value !== needle.value) {
            return new Map();
        }
        return new Map(
            (fleetSearch.data.value?.matches ?? []).map((match) => [match.id, match.snippet === undefined ? {} : { snippet: match.snippet }]),
        );
    });

    // One agent against the current query, local tier first — a hit this browser can prove costs nothing and
    // is already correct while the daemon's answer is still in flight.
    const hitOf = (agent: FleetAgent): AgentHit | undefined => {
        if (!active.value) {
            return undefined;
        }
        if (agent.title?.toLowerCase().includes(needle.value) === true) {
            return {};
        }
        const local = snippetFor(localPromptsOf(agent.id), needle.value);
        if (local !== undefined) {
            return { snippet: local };
        }
        return remote.value.get(agent.id);
    };

    const matches = (agent: FleetAgent): boolean => !active.value || hitOf(agent) !== undefined;
    const snippetOf = (agent: FleetAgent): string | undefined => hitOf(agent)?.snippet;

    /* Matching agents that are OFF the board — the archive. The board would otherwise answer "no matches"
     * for something sitting one click away, which is the failure a filter is least forgiven for.
     *
     * "Off the board" is a live question, not a synonym for "archived": an archived session the user has
     * started writing in is lifted back onto the lanes for as long as those words are there (see useAgents'
     * `fleet`). Listing it here as well would report one chat as two results — the card the query kept, and a
     * row underneath claiming the same chat is somewhere else. */
    const archivedMatches = computed(() => {
        if (!active.value) {
            return [];
        }
        const onBoard = new Set(useAgents().fleet.value.map((agent) => agent.id));
        return archived.value.filter((agent) => !onBoard.has(agent.id) && hitOf(agent) !== undefined);
    });

    // Matching conversations that no agent owns. Sessions carried by a fleet agent are dropped here so a
    // single conversation can't be reported twice — once as its card and once as an anonymous history row.
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
        active,
        matches,
        snippetOf,
        archivedMatches,
        sessionMatches,
        // "The daemon has not answered for what is currently typed" — the field's icon spins on it. True both
        // while the debounce runs and while the request is in flight, so the indicator never blinks between them.
        searching: computed(() => active.value && (settled.value !== needle.value || fleetSearch.isFetching.value || sessionSearch.isFetching.value)),
    };
}
