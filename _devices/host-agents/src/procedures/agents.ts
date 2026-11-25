import type { FixtureRouter } from "@intentic/contract-serve";
import { errorMessage } from "@intentic/base/errors";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { HostFolder, HostState } from "../state.js";

const NO_CONVERSATION = `No such conversation in this folder.`;
const STILL_RUNNING = `It is running a turn. Stop it first, then put it away.`;

// THE CONTRACT'S `agents` GROUP ON THIS COMPUTER: the board's cards for one folder's conversations, each one's
// transcript, and putting them away, back, and out of the archive for good. Everything about a private copy of the work
// (diffs, landing, conflicts, scratch files) is a sandbox's and is not served: a conversation here changes the reader's
// own files as they are.

// Put away and brought back, as a sandbox's board files its cards (2026-11-25): the record is kept whole either way,
// since there is no working copy to release here. A conversation running a turn stays where it is, said in `failed`.
const filingProcedures = (state: HostState, folder: HostFolder) =>
    ({
        archive: async ({ ids }) => {
            await state.loaded;
            const moved: AgentSummary[] = [];
            const failed: { id: string; reason: string }[] = [];
            for (const id of ids) {
                const record = state.records.get(id);
                if (record === undefined || record.folder !== folder.root) {
                    failed.push({ id, reason: NO_CONVERSATION });
                } else if (state.live.has(id)) {
                    failed.push({ id, reason: STILL_RUNNING });
                } else {
                    moved.push(state.card(state.amend(record, { archivedAt: state.now() })));
                }
            }
            return { moved, failed, rev: state.rev };
        },
        unarchive: async ({ ids }) => {
            await state.loaded;
            const moved = ids.flatMap((id) => {
                const record = state.records.get(id);
                if (record === undefined || record.folder !== folder.root || record.archivedAt === undefined) {
                    return [];
                }
                const { archivedAt: _filed, ...rest } = record;
                return [state.card(state.amend(rest, {}))];
            });
            return { moved, rev: state.rev };
        },
        // The archive emptied for good: each record's file goes, and with it what the chat would draw. The harness keeps its
        // own session beside its own sign-in, which is the reader's to clear in it. One that fails stays filed away.
        purge: async () => {
            await state.loaded;
            const filed = [...state.records.values()].filter((record) => record.folder === folder.root && record.archivedAt !== undefined);
            const removed = await Promise.all(
                filed.map(async (record) => {
                    try {
                        await state.store.remove(record.id);
                        state.records.delete(record.id);
                        return [record.id];
                    } catch (error) {
                        state.log(`could not delete conversation ${record.id}: ${errorMessage(error)}`);
                        return [];
                    }
                }),
            );
            return { removed: removed.flat() };
        },
    }) satisfies Pick<NonNullable<FixtureRouter[`agents`]>, `archive` | `unarchive` | `purge`>;

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
        ...filingProcedures(state, folder),
    }) satisfies FixtureRouter[`agents`];
