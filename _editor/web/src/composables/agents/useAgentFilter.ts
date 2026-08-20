import type { AgentSearchResult, MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, onScopeDispose, ref, watch } from "vue";
import { type ChatSession, useChat } from "../chat/useChat";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
import { type FleetAgent, useAgents } from "./useAgents";
import { AGENTS, SESSIONS } from "../queryKeys";

/* Filter the fleet by what was SAID in it, the board's header field and the popped-out rail's.
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
 *   2. DAEMON, debounced. Everything the browser does not hold: the rest of the conversation for agents this
 *      tab never opened, and every archived agent. Merges in when it lands.
 *
 * They are a union, never a replacement, the local tier keeps answering while the daemon one is in flight,
 * so refining a query never flashes the board empty. The daemon tier is the useWorkspaceSearch pattern
 * verbatim (TanStack, keepPreviousData, the abort signal threaded through) so a superseded query is cancelled
 * daemon-side instead of piling up behind the one the user is still typing.
 *
 * The MINIMUM is two characters, matching the daemon's own floor: below that every agent matches and the
 * filter is pure cost. One typed character therefore leaves the board alone rather than emptying it.
 *
 * MATCH CASE (the field's `Aa`) is the one piece of this that is NOT per-surface, and deliberately so: a query
 * is what one board is being looked at right now, while a case rule is how this person reads a search at all,
 * the same split useSearchOptions makes for the workspace box, and the same reason it survives a reload. Every
 * field that mounts this filter draws the switch, so a shared rule is never a rule you cannot see from where it
 * is acting. Off means case-INSENSITIVE, never smart case: a filter that changed rule by itself the moment a
 * capital was typed would make the switch beside it a lie.
 */

/* What an OPEN conversation SAID, as this browser holds it, matchable without asking the daemon. Both sides
 * of the chat: the user's prompts and the agent's own bubbles, which is the daemon's rule too (see
 * AgentSearchQuerySchema). A `notice` row is neither side speaking, and thinking and tool cards live on their
 * own fields of the message rather than in `text`, so what is left here is exactly the spoken half.
 */
const localLinesOf = (id: string): readonly { text: string; speaker: Speaker }[] => {
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    if (conversation === undefined) {
        return [];
    }
    return conversation.messages.value.flatMap((message) =>
        message.role === `user` || message.role === `assistant`
            ? [{ text: message.text, speaker: message.role === `user` ? (`user` as const) : (`agent` as const) }]
            : [],
    );
};

// How much of a matched line a card shows, the daemon's own SNIPPET_CHARS, applied to the local tier so a
// card looks the same whichever tier found it.
const SNIPPET_CHARS = 120;

// The user's own words win when both sides match, exactly as the daemon's matchLines does it: a query is typed
// from memory, and what a person remembers is their own phrasing.
const snippetFor = (lines: readonly { text: string; speaker: Speaker }[], needle: string, caseSensitive: boolean): MatchSnippet | undefined => {
    const said = (speaker: Speaker): MatchSnippet | undefined => {
        for (const spoken of lines) {
            if (spoken.speaker !== speaker) {
                continue;
            }
            const line = spoken.text.replace(/\s+/gu, ` `).trim();
            const at = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
            if (at === -1) {
                continue;
            }
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

// A match, and the evidence for it. `snippet` is absent when the hit was the TITLE, the card already shows
// that, and a line repeating the heading above it is noise where evidence was wanted.
interface AgentHit {
    readonly snippet?: MatchSnippet;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

/* The case rule, shared by every filter field and remembered across reloads, the habit, not the query. Written
 * through on change so the ref IS the preference and no caller has to remember to save it (useSearchOptions
 * says the same thing at greater length). Storage may be unavailable (private mode); the ref still holds for
 * the session. */
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
    // Folded ONCE, here, to whatever case rule is in force, every tier then runs one substring test against a
    // haystack folded the same way, and the marks on the cards are struck by the same needle.
    const needle = computed(() => (matchCase.value ? query.value.trim() : query.value.trim().toLowerCase()));
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

    /* The daemon's half of the query string. The MODE is not debounced with the text: flipping `Aa` is one
     * deliberate press rather than a keystroke burst, so it re-asks at once, and it is in the key as well as
     * the URL, because the same words under the other rule are a different search whose answer is cached
     * separately (useWorkspaceSearch keeps its switches in the key for exactly this reason). */
    const params = computed(() => `query=${encodeURIComponent(settled.value)}${matchCase.value ? `&caseSensitive=true` : ``}`);

    const fleetSearch = useQuery({
        queryKey: computed(() => AGENTS.of(`search`, params.value)),
        queryFn: ({ signal }) => sandboxJson<AgentSearchResult>(`/agents/search?${params.value}`, { signal }),
        enabled,
        placeholderData: keepPreviousData,
    });

    /* The never-carded conversations: sessions in this workspace that no agent entry owns, a plain chat, or an
     * agent whose registry entry is long gone. Fetched here rather than through useChat's `loadSessions`,
     * which writes the singleton list the History popover renders: a query typed on the board must not rewrite
     * what a popover in another corner of the app is showing.
     */
    const sessionSearch = useQuery({
        queryKey: computed(() => SESSIONS.of(`search`, params.value)),
        queryFn: ({ signal }) => sandboxJson<{ sessions: ChatSession[] }>(`/sessions?${params.value}`, { signal }),
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

    // One agent against the current query, local tier first, a hit this browser can prove costs nothing and
    // is already correct while the daemon's answer is still in flight.
    const hitOf = (agent: FleetAgent): AgentHit | undefined => {
        if (!active.value) {
            return undefined;
        }
        const title = matchCase.value ? agent.title : agent.title?.toLowerCase();
        if (title?.includes(needle.value) === true) {
            return {};
        }
        const local = snippetFor(localLinesOf(agent.id), needle.value, matchCase.value);
        if (local !== undefined) {
            return { snippet: local };
        }
        return remote.value.get(agent.id);
    };

    const matches = (agent: FleetAgent): boolean => !active.value || hitOf(agent) !== undefined;
    const snippetOf = (agent: FleetAgent): MatchSnippet | undefined => hitOf(agent)?.snippet;

    /* Matching agents that are OFF the board, the archive. The board would otherwise answer "no matches"
     * for something sitting one click away, which is the failure a filter is least forgiven for.
     *
     * "Off the board" is a live question, not a synonym for "archived": an archived session the user has
     * started writing in is lifted back onto the lanes for as long as those words are there (see useAgents'
     * `fleet`). Listing it here as well would report one chat as two results, the card the query kept, and a
     * row underneath claiming the same chat is somewhere else. */
    const archivedMatches = computed(() => {
        if (!active.value) {
            return [];
        }
        const onBoard = new Set(useAgents().fleet.value.map((agent) => agent.id));
        return archived.value.filter((agent) => !onBoard.has(agent.id) && hitOf(agent) !== undefined);
    });

    // Matching conversations that no agent owns. Sessions carried by a fleet agent are dropped here so a
    // single conversation can't be reported twice, once as its card and once as an anonymous history row.
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
        // The `Aa` switch itself, for the field to bind and the cards to mark by, one preference, so every
        // surface showing it shows the same one.
        matchCase,
        active,
        matches,
        snippetOf,
        archivedMatches,
        sessionMatches,
        // "The daemon has not answered for what is currently typed", the field's icon spins on it. True both
        // while the debounce runs and while the request is in flight, so the indicator never blinks between them.
        searching: computed(() => active.value && (settled.value !== needle.value || fleetSearch.isFetching.value || sessionSearch.isFetching.value)),
    };
}
