import type { FixtureRouter } from "@intentic/contract-serve";
import type { HostFolder, HostState } from "../state.js";

// THE CONTRACT'S `agents` GROUP ON THIS COMPUTER: the board's cards for one folder's conversations and each one's
// transcript. Everything about a private copy of the work (diffs, landing, conflicts, scratch files) is a sandbox's and
// is not served: a conversation here changes the reader's own files as they are.

export const agentsProcedures = (state: HostState, folder: HostFolder) =>
    ({
        list: async () => {
            await state.loaded;
            return { agents: state.cardsOf(folder.root, false), rev: state.rev, held: [] };
        },
        archived: async () => {
            await state.loaded;
            return { agents: state.cardsOf(folder.root, true), rev: state.rev, held: [] };
        },
        get: async ({ id }) => {
            await state.loaded;
            return state.card(state.recordIn(folder, id));
        },
        // The whole settled record in one page: a conversation here is one reader's, and its record is kept whole. A
        // turn running now is not in it yet; `live` names the run to attach to for its rows.
        transcript: async ({ id, after, afterRow }) => {
            await state.loaded;
            const record = state.recordIn(folder, id);
            const { rows } = record;
            // Reading forward from a reader's cursor: only what the record gained, where it still runs through there.
            const carriesOn = after !== undefined && after <= rows.length && (after === 0 || rows[after - 1]?.rowId === afterRow);
            const from = carriesOn ? after : 0;
            const page: Awaited<ReturnType<NonNullable<NonNullable<FixtureRouter[`agents`]>[`transcript`]>>> = {
                messages: rows.slice(from),
                from,
                more: false,
                through: rows.length,
                provider: record.provider,
                harness: `native`,
            };
            if (after !== undefined) {
                page.continuous = carriesOn;
            }
            if (record.sessionId !== undefined) {
                page.sessionId = record.sessionId;
            }
            const running = state.live.get(id)?.run.id;
            if (running !== undefined) {
                page.live = running;
            }
            return page;
        },
        rename: async ({ id, title }) => {
            await state.loaded;
            return state.card(state.amend(state.recordIn(folder, id), { title }));
        },
        seen: async ({ id }) => {
            await state.loaded;
            return state.card(state.amend(state.recordIn(folder, id), { seenAt: state.now() }));
        },
    }) satisfies FixtureRouter[`agents`];
