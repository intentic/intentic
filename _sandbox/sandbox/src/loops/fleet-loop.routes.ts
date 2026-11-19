import { newConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { turnReader } from "../auth/scope/turn-reader.js";
import type { Services } from "../composition.js";
import { closingOf } from "../agent/run/turn/turn-closing.js";
import { resolveFleetHandle } from "../conversations/recall/fleet-handles.js";
import { candidateOf } from "../conversations/recall/fleet-recall.js";
import { readableHandle } from "../conversations/recall/fleet-reads.js";
import { isIsolated, type PersistedAgent, worktreeOf } from "../conversations/registry/agents-store.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { contextContinueDeps, continueFresh } from "./context-continue.js";
import { LoopAskSchema, loopOfAsk } from "./fleet-loop.js";
import { loopRunning, runLoop, stopLoop } from "./loop-runner.js";

// The shell doors `agents loop` and `agents continue` reach (bin/agents), on the agent token like the fleet's other
// writes: what a person does with a conversation's card, never more. `loop` starts repeating a prompt on a conversation
// (fleet-loop.ts), `loop/stop` makes the round in flight the last, and `continue` carries a conversation on in a fresh
// session, opened with what its last turn said was left (context-continue.ts). Each names its conversation by any handle
// `agents show` takes, and reaches only one the calling turn may read.

const TargetBodySchema = z.object({ to: z.string().min(1) });

// A conversation the caller may act on, or the refusal it is answered with.
const targetOf = async (services: Services, c: Context<AppEnv>, handle: string): Promise<PersistedAgent | Response> => {
    const resolved = readableHandle(await resolveFleetHandle(services, handle), await turnReader(services, c));
    if (resolved.kind === "ambiguous") {
        return c.json(
            { ok: false, message: `\`${handle}\` matches ${resolved.candidates.length} conversations; name one of them.`, candidates: resolved.candidates.map(candidateOf) },
            409,
        );
    }
    if (resolved.kind === "unknown") {
        return c.json({ ok: false, message: `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.` }, 404);
    }
    if (resolved.entry.archivedAt !== undefined) {
        return c.json({ ok: false, message: `\`${resolved.entry.id}\` is archived; a person reopens it first.` }, 409);
    }
    if (worktreeOf(resolved.entry)?.parent !== undefined) {
        return c.json({ ok: false, message: `\`${resolved.entry.id}\` is a subagent: the agent that started it drives it (\`agents send\`).` }, 409);
    }
    return resolved.entry;
};

// A body as its schema reads it, or the 400 naming what was wrong with it.
const bodyOf = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>, example: string): Promise<T | Response> => {
    // allow(silent-catch): an unreadable body is answered as a 400 naming the shape it should have had.
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : c.json({ ok: false, message: `${parsed.error.issues[0]?.message ?? "invalid body"}. Pass JSON like ${example}.` }, 400);
};

// Settles once the conversation has no turn running: at once when it has none, else when its run settles. What lets an
// agent loop its own conversation, whose first round has to wait for the turn that asked for it to end.
const once = (services: Pick<Services, "conversations" | "events">, conversationId: string): Promise<void> =>
    services.conversations.running(conversationId)
        ? new Promise((resolve) => {
              const off = services.events.subscribe("run.settled", (settled) => {
                  if (settled.conversationId === conversationId) {
                      off();
                      resolve();
                  }
              });
          })
        : Promise.resolve();

/** POST /fleet/loop: start repeating a prompt on a conversation, a new one where the ask names none. */
const startLoop =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const ask = await bodyOf(c, LoopAskSchema, `{"prompt": "…", "until": "<command>", "on": "<handle>"}`);
        if (ask instanceof Response) {
            return ask;
        }
        const entry = ask.on === undefined ? undefined : await targetOf(services, c, ask.on);
        if (entry instanceof Response) {
            return entry;
        }
        // A new conversation gets a checkout of its own, so its rounds land like any agent's work.
        const target = entry === undefined ? { conversationId: newConversationId(), isolated: true } : { conversationId: entry.id, isolated: isIsolated(entry) };
        // Its record too: a loop still waiting for the turn that asked for it to end holds no pump yet.
        if (loopRunning(services.conversations, target.conversationId) || (await services.loops.get(target.conversationId))?.state === "running") {
            return c.json({ ok: false, message: `\`${target.conversationId}\` is already looping: stop that loop first (\`agents loop --stop ${target.conversationId}\`).` }, 409);
        }
        const record = await services.loops.start(loopOfAsk(ask, target), Date.now());
        const waits = services.conversations.running(target.conversationId);
        // Detached, as the loops route runs it: a loop outlives the request by hours; its rounds are on the card.
        void once(services, target.conversationId).then(() => runLoop(services, record));
        return c.json({ ok: true, conversationId: target.conversationId, waits, loop: record });
    };

/** POST /fleet/loop/stop: make the round in flight the conversation's last. */
const stopLoopRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const body = await bodyOf(c, TargetBodySchema, `{"to": "<handle>"}`);
        if (body instanceof Response) {
            return body;
        }
        const entry = await targetOf(services, c, body.to);
        if (entry instanceof Response) {
            return entry;
        }
        return stopLoop(services.conversations, entry.id)
            ? c.json({ ok: true, conversationId: entry.id })
            : c.json({ ok: false, message: `No loop is running on \`${entry.id}\`.` }, 404);
    };

/** POST /fleet/continue: carry a conversation on in a fresh session, opened with what its last turn said was left. */
const continueRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const body = await bodyOf(c, TargetBodySchema, `{"to": "<handle>"}`);
        if (body instanceof Response) {
            return body;
        }
        const entry = await targetOf(services, c, body.to);
        if (entry instanceof Response) {
            return entry;
        }
        const deps = contextContinueDeps(services);
        // A loop between rounds, or words already waiting, has its next move: a turn started here would race it.
        const started = deps.busy(entry.id) ? undefined : await continueFresh(deps, entry.id, closingOf(await services.transcripts.rows(entry)));
        return started === undefined
            ? c.json({ ok: false, message: `\`${entry.id}\` cannot take a turn now: one is running, words wait for it, or it is looping. Wait for it, or stop it first.` }, 409)
            : c.json({ ok: true, conversationId: entry.id, run: started.id });
    };

export const fleetLoopRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /fleet/loop": startLoop(services),
    "POST /fleet/loop/stop": stopLoopRoute(services),
    "POST /fleet/continue": continueRoute(services),
}));
