import { sandboxRouteFor } from "@intentic/sandbox-contract";
import type { SandboxHandlerInput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { LoopIdParamSchema } from "@intentic/sandbox-contract/schemas/loops";
import { SealSetDefaultSchema } from "@intentic/sandbox-contract/schemas/seal";
import type { DemoHandler } from "../../transport";
import { broadcastRoster, roster } from "../board/roster";
import { readOnlyForCaller, sealedFromCaller, startSealed } from "./sealWorld";

// THE DOORS A SEAL CLOSES, held at the demo daemon's front as the daemon's own conversation lookups hold them
// (conversations/agent-lookups.ts): a conversation sealed from the reader hands out none of its words and takes none,
// while its work (its diff, its land, its archive, its conflicts) stays the team's. One the reader was shown for a day, or
// opened without asking, is read and never written. Both answer the daemon's FORBIDDEN with the reason the editor reads
// as a seal (client/sandbox/access/accessReason.ts `sealed`). The message that opens a conversation seals it as asked.

// Every route that hands out a conversation's words, or writes into them.
const WORDS = new Set([
    `agents.transcript`,
    `agents.toolChildren`,
    `agents.subagentTranscript`,
    `agents.documents`,
    `agents.systemPrompt`,
    `GET /agents/{id}/documents/raw`,
    `agent.attach`,
]);
const WRITES = new Set([
    `agents.rename`,
    `agents.react`,
    `agents.place`,
    `agent.run`,
    `agent.reply`,
    `agent.steer`,
    `agent.stop`,
    `agent.resume`,
    `agent.rewind`,
    `agent.chooseHandoff`,
    `agent.switchAccount`,
    `agent.queueEdit`,
    `agent.queueRemove`,
    `agent.queueResume`,
    `agent.queueReroute`,
    `agent.queueSchedule`,
    `agent.queueContinue`,
    `share.create`,
]);

// What of a body the gate reads, by the contract's own words for it: the conversation it names, and whether the message
// that opens one asked for it private. Every other field is the procedure's, which the router parses after this.
const NamedSchema = LoopIdParamSchema.extend(SealSetDefaultSchema.shape).partial().loose();
type Named = Partial<Pick<SandboxHandlerInput<`agent`, `run`>, "conversationId" | "private">>;

const bodyNamed = (text: string): Named => {
    const parsed = NamedSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
};

// The conversation a request names: its path's `{id}`, else the query's or the body's `conversationId`.
const conversationOf = async (request: Request, url: URL, template: string): Promise<Named> => {
    const actual = url.pathname.split(`/`);
    const at = template.split(`/`).indexOf(`{id}`);
    if (at >= 0 && actual[at] !== undefined) {
        return { conversationId: decodeURIComponent(actual[at]) };
    }
    const query = url.searchParams.get(`conversationId`);
    if (query !== null) {
        return { conversationId: query };
    }
    const text = request.method === `GET` ? `` : await request.clone().text();
    return text === `` ? {} : bodyNamed(text);
};

const refused = (error: string): Response =>
    new Response(JSON.stringify({ error, reason: `sealed` }), { status: 403, headers: { "content-type": `application/json` } });

export const withSeals =
    (daemon: DemoHandler): DemoHandler =>
    async (request, url) => {
        const route = sandboxRouteFor(request.method, url.pathname);
        if (route === undefined || (!WORDS.has(route.name) && !WRITES.has(route.name))) {
            return daemon(request, url);
        }
        const named = await conversationOf(request, url, route.path);
        const id = named.conversationId;
        if (id === undefined) {
            return daemon(request, url);
        }
        if (sealedFromCaller(id)) {
            return refused(`This conversation is private.`);
        }
        if (WRITES.has(route.name) && readOnlyForCaller(id)) {
            return refused(`You can read this conversation, not write in it.`);
        }
        const opens = route.name === `agent.run` && !roster.agents.some((agent) => agent.id === id);
        const answer = await daemon(request, url);
        if (opens && answer.ok) {
            startSealed(id, named.private);
            broadcastRoster();
        }
        return answer;
    };
