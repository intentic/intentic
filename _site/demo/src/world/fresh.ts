import { sandboxContract, sandboxRouteFor } from "@intentic/sandbox-contract";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { DemoHandler } from "../transport";
import { json } from "../transport";
import { answersNothing } from "./addresses";
import { madeOnThisPage, rowAt } from "./sandboxRegistry";

// THE SANDBOXES A VISITOR MAKES, as the one fixture daemon answers them. A sandbox made on this page (Add sandbox, or
// one restored from the trash) is on its first day: its own name, and a board holding only the conversations started in
// it. Everything else it is asked is the shared fixture's, which is what keeps a new sandbox's chat, settings and the
// rest working rather than empty. The demo's own sandboxes in turn no longer list what was started in a new one.

// The conversations started in a sandbox made on this page, by its address.
const startedAt = new Map<string, Set<string>>();

const freshRowAt = (url: URL) => {
    const row = rowAt(url.origin);
    return row !== undefined && madeOnThisPage(row.id) ? row : undefined;
};

// A conversation belongs to the address it was started at; one started nowhere new is the demo's own. A home conversation
// has the same id in every sandbox (it is named after its person), so a new sandbox has its own once it is written in, and
// writing in it takes nothing from the others.
const belongsAt = (id: string, origin: string): boolean => {
    if (isHomeConversationId(id)) {
        return freshRowAt(new URL(origin)) === undefined || startedAt.get(origin)?.has(id) === true;
    }
    const home = [...startedAt].find(([, ids]) => ids.has(id))?.[0];
    return home === undefined ? freshRowAt(new URL(origin)) === undefined : home === origin;
};

// The board's reads: one answer shape, `{ agents, rev, held }`, kept to the conversations of the address asked.
const BOARD_READS = new Set([`agents.list`, `agents.archived`, `agents.seenAll`]);

// The board and a run's input, read with the contract's own schemas: what the editor sent, and what the fixture answered.
const BOARD = sandboxContract.agents.list[`~orpc`].outputSchema;
const RUN = sandboxContract.agent.run[`~orpc`].inputSchema;

const keptToAddress = async (response: Response, url: URL): Promise<Response> => {
    const read = response.ok && BOARD !== undefined ? await BOARD[`~standard`].validate(await response.json()) : undefined;
    if (read === undefined || read.issues !== undefined) {
        return response;
    }
    const board = read.value;
    const fresh = freshRowAt(url) !== undefined;
    return json({ ...board, agents: board.agents.filter((agent) => belongsAt(agent.id, url.origin)), held: fresh ? [] : board.held });
};

// The conversation a run is for, off the request's own body, before the daemon reads it.
const conversationOf = async (request: Request): Promise<string | undefined> => {
    const sent = await request
        .clone()
        .json()
        // allow(silent-catch): a body that is not JSON names no conversation, and the contract's schema below refuses it anyway.
        .catch(() => undefined);
    const read = RUN === undefined ? undefined : await RUN[`~standard`].validate(sent);
    return read === undefined || read.issues !== undefined ? undefined : read.value.conversationId;
};

/** The fixture daemon, answering each sandbox the visitor made as its own and an address named as down as nothing. */
export const withWorld =
    (daemon: DemoHandler): DemoHandler =>
    async (request, url) => {
        // Nothing listens at an address named as down: the fetch fails as an unreachable host's does.
        if (answersNothing(url)) {
            throw new TypeError(`Failed to fetch`);
        }
        const route = sandboxRouteFor(request.method, url.pathname)?.name;
        const row = freshRowAt(url);
        if (row !== undefined && route === `system.info`) {
            return json({ name: row.name, version: `demo`, latest: `demo`, updateAvailable: false });
        }
        // The rail chip's two counts: until something is started in a new sandbox, nothing of it needs anyone or works.
        if (row !== undefined && startedAt.get(url.origin) === undefined && (route === `agents.attention` || route === `agents.attentionMine`)) {
            return json({ needsYou: 0, working: 0 });
        }
        if (row !== undefined && route === `agent.run`) {
            const id = await conversationOf(request);
            if (id !== undefined) {
                startedAt.set(url.origin, (startedAt.get(url.origin) ?? new Set()).add(id));
            }
        }
        const response = await daemon(request, url);
        const keptHere = route !== undefined && BOARD_READS.has(route) && (row !== undefined || startedAt.size > 0);
        return keptHere ? keptToAddress(response, url) : response;
    };
