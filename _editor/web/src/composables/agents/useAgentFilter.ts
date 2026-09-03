import type { AgentSearchResult, MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { Conversation } from "../chat/conversation";
import { type ChatSession, useChat } from "../chat/useChat";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
import { type FleetAgent, useAgents } from "./useAgents";
import { AGENTS, SESSIONS } from "../queryKeys";

/* Filter the fleet by what was SAID in it: the board's header field, and the chat rail's.
 *
 * A FACTORY, not a singleton. The query is how ONE surface is being looked at right now, exactly like the
 * board's showAllFinished / archiveOpen, and the rail is routinely in a different WINDOW: a filter typed on the
 * board silently narrowing a floating chat the user isn't looking at would be a spooky action at a distance.
 * Each caller owns its own.
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
 *
 * FOLDED ONCE, HERE, rather than inside the match test. Collapsing a line's whitespace and lowercasing it is
 * what a test against it costs, and the board asks about a card roughly seven times per render (see `finder`
 * below), so every message of every open chat went through that regex seven times to answer one keystroke.
 * What is left in the scan is a bare `indexOf`.
 */
interface SpokenLine {
    // The line as a snippet quotes it: whitespace collapsed, trimmed.
    readonly text: string;
    // ...and as the one substring test reads it. Literally the same string when the case rule is on, so the
    // fold costs nothing there.
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

// How much of a matched line a card shows, the daemon's own SNIPPET_CHARS, applied to the local tier so a
// card looks the same whichever tier found it.
const SNIPPET_CHARS = 120;

// The user's own words win when both sides match, exactly as the daemon's matchLines does it: a query is typed
// from memory, and what a person remembers is their own phrasing.
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

    /* WHETHER THE ANSWER ON SCREEN IS THE WHOLE ANSWER, which is a different question from "is a request in
     * flight" and the one the board was getting wrong.
     *
     * Matching is two tiers: this browser matches open conversations and titles instantly, then merges the
     * daemon's answer for everything it does not hold (the rest of the fleet, and the whole archive). In
     * between, the board showed a confident list with a "N of M" tally beside it, which asserts completeness
     * about a list that was missing every chat this tab had never opened. Users searched, saw three results and
     * moved on: a wrong answer, delivered with no sign it was provisional.
     *
     * So it reports the gap instead. Two ways to have one, and they read the same to the user:
     *   - the daemon has not answered for what is currently typed (debounce, or a request in flight)
     *   - it has answered, but said its own index is still being filled (`indexing`), so its answer can grow
     */
    const partial = computed(() => {
        if (!active.value) {
            return false;
        }
        if (settled.value !== needle.value || fleetSearch.isFetching.value || sessionSearch.isFetching.value) {
            return true;
        }
        return fleetSearch.data.value?.indexing === true;
    });

    /* WHAT THIS BROWSER CAN MATCH, INDEXED ONCE PER CHANGE instead of re-read per card.
     *
     * Gated on `active`, and that gate is the point: with nothing in the box this must cost nothing, and an
     * index built anyway would take a reactive dependency on every message of every open chat and rebuild
     * itself on each frame of every streaming turn to answer a question nobody asked. */
    const localLines = computed<ReadonlyMap<string, readonly SpokenLine[]>>(() => {
        if (!active.value) {
            return new Map();
        }
        const caseSensitive = matchCase.value;
        return new Map(
            useChat().conversations.value.map((conversation) => [conversation.conversationId, linesOf(conversation, caseSensitive)]),
        );
    });

    /* A HIT'S OWN IDENTITY, HELD ACROSS EVALUATIONS, because `snippetOf(agent)` is one of the board's `v-memo`
     * dependencies (AgentsView). Re-deriving the index hands back an equal-but-new snippet object, and to
     * `v-memo` a new object IS a change: every matched card would redraw on every roster frame, which is the
     * exact cost that memo exists to remove. So a hit that still says the same thing keeps the object it was
     * last reported as. Keyed by card rather than by card-and-title: a rename may change WHETHER an agent is
     * hit, but where the evidence is unchanged it is still the same evidence. */
    const held = new Map<string, AgentHit>();
    const sameHit = (left: AgentHit, right: AgentHit): boolean =>
        left.snippet === right.snippet ||
        (left.snippet !== undefined &&
            right.snippet !== undefined &&
            left.snippet.text === right.snippet.text &&
            left.snippet.speaker === right.snippet.speaker);
    /* One card, addressed by BOX AND ID and never by id alone: ids are minted per daemon, so the wider board
     * can hold two cards carrying the same id from two sandboxes (fleetScope's own cardKey draws the same
     * distinction, and AgentsView's pendingFor says why at length), and one would answer for the other. */
    const cardKey = (agent: FleetAgent): string => `${agent.sandboxId ?? ``}/${agent.id}`;

    /* ONE AGENT AGAINST THE CURRENT QUERY, local tier first: a hit this browser can prove costs nothing and is
     * already correct while the daemon's answer is still in flight.
     *
     * A MEMOISING CLOSURE re-minted on every change, rather than a plain function, because of how often the
     * board asks. `cardsFor` runs five times over per render (the lane's v-for, its empty-lane guard,
     * laneCount -> keptIn, the `kept` tally and paneOrder) and each pass tests every card in the lane, then
     * `snippetOf` is read twice more for the card actually drawn. Every one of those calls used to re-find the
     * conversation in the chat list and rescan its whole transcript, so a single keystroke on a board with a
     * dozen chats open spent ~50ms repeating itself: past the frame budget, on the one path that has to keep
     * up with typing.
     *
     * A computed rather than a cache keyed off the query, because the answer has to STAY right: every input
     * here is reactive (the query, the case rule, each open transcript, the daemon's reply), and a hand-rolled
     * cache would go on answering "no match" for a word a streaming turn had since said. Same reads, same
     * invalidation, one evaluation.
     *
     * The TITLE rides in the memo key because it is the one input the closure reads lazily, off the agent it is
     * handed: everything else was captured above and therefore invalidates this whole computed. Without it a
     * rename would keep answering for the old name for as long as the query stood. */
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
        // "…and what you can see is therefore not all of it", which is what the board says out loud instead of
        // counting a partial list as if it were the whole fleet.
        partial,
    };
}
