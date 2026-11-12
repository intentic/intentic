import { candidateOf } from "./fleet-recall.js";
import { turnReader } from "../../auth/scope/turn-reader.js";
import type { Context } from "hono";
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { soleLiveConversation } from "../actor/conversation-holdings.js";
import { messageConversation } from "./fleet-message.js";
import { type ResumeAsk, resumeConversation } from "./fleet-resume.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { resolveFleetHandle } from "./fleet-handles.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { createFleetReads, readableHandle } from "./fleet-reads.js";
import { withBaseText } from "../../agent/prompt/prompt-disclosure.js";
import { relayFleetRead } from "../../links/link-records-relay.js";

// The shell door onto the daemon's fleet knowledge (registry, record, worktree composition, phrase index), joined into
// one answer. Its own namespace, not `/agents`: the board's router can land, discard and rename, so what lives here
// costs one grants.ts line each and cannot reach those. Serves a CLI parsing JSON, not a typed client.
//
// Reads, and two writes, each something a person does in a conversation's chat: `message` says something to it
// (fleet-message.ts), rate-limited and attributed there, and `resume` presses its Continue (fleet-resume.ts), which
// re-runs a turn a spent allowance or a stop held, optionally on another model or account. Neither can land, archive,
// rename or discard anything.

// Ceiling on one message: a peer needs a paragraph or two, not a file. Anything longer is a file to point at.
const MAX_MESSAGE_CHARS = 8_000;

// A wait's default and ceiling, the children's own (children.routes.ts): long enough for a real turn, short enough that a
// forgotten wait still returns.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const MessageBodySchema = z.object({
    to: z.string().min(1),
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    // `agents message --wait`: answer once the turn the message reached settles, with how it ended (fleet-message-wait.ts).
    wait: z.boolean().optional(),
    timeoutSeconds: z.number().positive().max(WAIT_MAX_S).optional(),
});

// Where a resumed turn goes; every field left out keeps the conversation's own.
const ResumeBodySchema = z.object({
    to: z.string().min(1),
    provider: AgentProviderSchema.optional(),
    harness: AgentHarnessSchema.optional(),
    model: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
});

// A write's body as its schema reads it, or undefined for one that is not JSON or not that shape: the caller answers
// either with its own usage line.
const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | undefined> => {
    // allow(silent-catch): an unreadable body is answered as a 400 naming the shape it should have had.
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : undefined;
};

// Who is writing: the turn's own stamp, else the one turn in flight (the attribution the children routes use).
const callerOf = (services: Services, c: Context<AppEnv>): string | undefined => {
    const from = c.req.header("x-intentic-conversation") ?? soleLiveConversation(services.conversations);
    return from === "" ? undefined : from;
};

// A refused write as the CLI reads it, with the conversations an ambiguous handle matched when there were some.
interface WriteRefusal {
    readonly ok: false;
    readonly message: string;
    readonly candidates?: readonly ReturnType<typeof candidateOf>[];
}
const refusalBody = (message: string, candidates: readonly PersistedAgent[] | undefined): WriteRefusal =>
    candidates === undefined ? { ok: false, message } : { ok: false, message, candidates: candidates.map(candidateOf) };

/** POST /fleet/resume: press another conversation's Continue — its held turn again, or carry on where it ended. */
const resumeRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const body = await bodyOf(c, ResumeBodySchema);
        if (body === undefined) {
            return c.json(
                {
                    ok: false,
                    message: 'Pass JSON like {"to": "<handle>", "provider": "claude", "model": "claude-opus-5-5"}; every field but `to` is optional.',
                },
                400,
            );
        }
        const { to, ...ask } = body;
        const outcome = await resumeConversation(services, callerOf(services, c), to, ask satisfies ResumeAsk);
        return outcome.ok ? c.json(outcome) : c.json(refusalBody(outcome.message, outcome.candidates), outcome.status);
    };

// A read made by the agent's `--on <link>`: the same question of a linked sandbox, relayed through its records doors.
const orOnLink =
    (services: Services, read: (c: Context<AppEnv>) => Promise<Response>) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const on = c.req.query("on");
        return on === undefined || on === "" ? read(c) : relayFleetRead(services, c, on);
    };

// Full Services, not a Pick: `message` starts turns, and a turn is the whole daemon.
const createFleetRoutes = (services: Services) => ({
    // The bundle's system prompt with its base's own text, as GET /agents/{id}/system-prompt answers it.
    ...createFleetReads(
        services,
        (c) => turnReader(services, c),
        async (id) => {
            const recorded = await services.promptRecord.of(id);
            return recorded === undefined ? undefined : await withBaseText(recorded, services.workspace.root);
        },
    ),
    /** POST /fleet/message: say something to another conversation — steered into its live turn, opening one, or queued
     *  behind one; with `wait`, answered once the turn it reached settles. */
    message: async (c: Context<AppEnv>): Promise<Response> => {
        const body = await bodyOf(c, MessageBodySchema);
        if (body === undefined) {
            return c.json(
                {
                    ok: false,
                    message: `Pass JSON like {"to": "<handle>", "message": "…"}, with "wait": true and "timeoutSeconds" up to ${WAIT_MAX_S} to wait for the turn it reaches.`,
                },
                400,
            );
        }
        const wait =
            body.wait === true ? { timeoutMs: Math.round((body.timeoutSeconds ?? WAIT_DEFAULT_S) * 1000), signal: c.req.raw.signal } : undefined;
        // Words in front of a conversation this turn may not read would read its reply back (`--wait`): as no conversation.
        if (readableHandle(await resolveFleetHandle(services, body.to), await turnReader(services, c)).kind === "unknown") {
            return c.json(refusalBody(`No conversation answers to \`${body.to}\`. Search for one with \`agents find "<text>"\`.`, undefined), 404);
        }
        const outcome = await messageConversation(services, callerOf(services, c), body.to, body.message, undefined, wait);
        return outcome.ok ? c.json(outcome) : c.json(refusalBody(outcome.message, outcome.candidates), outcome.status);
    },
});

// The fleet surface: which conversations exist, what one is, which said a phrase — joined from the registry, the
// record, the worktree composition and the phrase index — and saying something to one of them or pressing its Continue.
// Scoped to the agent token like `services`/`capabilities`, unlike `/agents`: the reads cannot change anything, and the
// two writes only do what a person can do in a conversation's chat: type, or press Continue.
export const fleetRawRoutes = defineRawRoutes((services: Services) => {
    const fleetRoutes = createFleetRoutes(services);
    return {
        "GET /fleet": orOnLink(services, fleetRoutes.list),
        "POST /fleet/message": fleetRoutes.message,
        "POST /fleet/resume": resumeRoute(services),
        "GET /fleet/{handle}": orOnLink(services, fleetRoutes.show),
        "GET /fleet/{handle}/bundle": orOnLink(services, fleetRoutes.bundle),
    };
});
