import { IN_MEMORY } from "@intentic/base/sqlite";
import { capabilitiesOf } from "@intentic/sandbox-contract";
import type { SliceFakeContext } from "../harness/slice-fake.testing.js";
import { toolChildrenOf, transcriptPageOf } from "./agent-transcript.js";
import { openSearchIndex } from "./search-index.js";
import type { SessionsSlice } from "./sessions-slice.js";
import { spokenLinesOf } from "./transcript-search.js";

// The sessions slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const sessionsSliceFake = (context: SliceFakeContext) => {
    const { self } = context;
    // The phrase index these suites search through: production schema and SQL, over nothing.
    const testSaid = openSearchIndex(IN_MEMORY);
    return {
        sessions: {
            list: async () => [],
            read: async () => [],
            // Empty is the documented fallback for no readable store: an interrupted turn recorded from its prompt
            // alone.
            readTail: async () => [],
            search: async () => [],
            exists: async () => true,
        },
        // Defaults to the claude-code-only shape production reads before a provider-native record exists, keyed off the
        // actors' `sessionIdOf`. Reads through the finished services, so an override of `sessions.read` or
        // `conversations` applies here too.
        transcripts: {
            read: async (agent) => {
                const services = self();
                const profile = services.agents.entry(agent.id)?.profile;
                const sessionId =
                    profile !== undefined && capabilitiesOf(profile.provider, profile.harness).runtime === "claude-code"
                        ? services.conversations.sessionIdOf(agent.id)
                        : undefined;
                return sessionId === undefined ? [] : services.sessions.read(services.workspace.root, sessionId);
            },
            // The fake keeps no out-of-line bytes, so what a page reads of each row is the row.
            rows: async (agent) => self().transcripts.read(agent),
            // Derived from `read` via production's own window rule, so a route test can't disagree with the daemon.
            page: async (agent, window = {}) => transcriptPageOf(await self().transcripts.read(agent), window),
            // Same door, same source: a route test asking for a delegation's calls gets what the record-backed route would.
            toolChildren: async (agent, toolId) => toolChildrenOf(await self().transcripts.read(agent), toolId),
            lastSaid: async (agent) => (await self().transcripts.read(agent)).findLast((row) => row.role === "assistant")?.text,
            // Inert but present: a fork's first turn opens through this door, so a fake without it fails every forkOf
            // turn with a bare 500 that no type check catches.
            fork: async () => {},
            append: async () => {},
            // Derived from `read`, so the fake's answers can't disagree with each other. `count` is on the turn path
            // (each checkpoint's index), so omitting it fails every agent.run test silently.
            count: async (agent) => (await self().transcripts.read(agent)).length,
            // Inert, but answers what a real truncate would have dropped, so a rewind test can assert on the count.
            truncate: async (agent, keep) => Math.max(0, (await self().transcripts.read(agent)).length - keep),
            migrate: async () => {},
            sweep: async () => {},
        },
        // The real index, in memory: a fake here would mean no suite ever runs the actual query, folding or ordering.
        // `search` syncs from `transcripts.read` first, since `append` is inert.
        saidIndex: {
            search: async (needle, kind, caseSensitive) => {
                if (kind === "conversation") {
                    const services = self();
                    for (const id of services.agents.ids()) {
                        const entry = services.agents.entry(id);
                        if (entry !== undefined) {
                            await testSaid.put(id, "conversation", "test", spokenLinesOf(await services.transcripts.read(entry)));
                        }
                    }
                }
                return testSaid.search(needle, kind, caseSensitive);
            },
            backfill: async () => {},
            indexing: () => false,
        },
        purgeConversationState: async () => {},
    } satisfies SessionsSlice;
};
