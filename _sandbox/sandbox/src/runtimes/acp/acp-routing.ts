import type {
    ClientApp,
    CreateElicitationRequest,
    CreateElicitationResponse,
    CreateTerminalRequest,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { methods, RequestError } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { type AcpDialect, type ChildSession, type DialectReader, type Json, placeUpdate, type VendorQuestion } from "@intentic/acp-events/dialects";
import { z } from "zod";
import { decidePermission } from "./acp-permissions.js";
import { recordOptions, type SessionOptions } from "@intentic/acp-events/model";
import { noteMode, type SessionModes } from "@intentic/acp-events/modes";
import type { PreparedTerminal } from "./acp-terminal.js";

// How a connection hands each session's traffic to the turn bound to it, kept apart from the process that carries it
// (acp-connection.ts) so the in-process test fixture routes exactly the same way without a spawn.

export interface TurnHooks {
    // One of the session's updates, or, with `child` set, one of a child session the agent opened for a subagent this
    // session spawned (acp-events dialects), read under the spawning call's card.
    readonly onUpdate: (notification: SessionNotification, child?: ChildSession) => void;
    // Frames the agent's dialect read from what it said beyond the protocol. Called with none as well, whenever the
    // dialect read anything, so a turn held open for the agent's own wake-up (`DialectReader.holding`) looks again.
    readonly onFrames?: (events: readonly AgentEvent[]) => void;
    // A question the agent asks through a request of its own (dialect `question`): parks on a question card. Absent,
    // the agent hears nobody answered.
    readonly ask?: (question: VendorQuestion) => Promise<Json>;
    // Can park: the owner's rulebook may hold this call for approval while the agent waits on the response.
    readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    // A form the agent asks a person to fill (elicitation/create): parks on a question card. Absent, the form is
    // declined.
    readonly elicit?: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
    // Turn's tmux session, cwd and first-create signal for terminal requests; absent refuses them.
    readonly terminal?: {
        readonly session: string;
        readonly cwd: string;
        readonly onCreate: () => void;
        // The rulebook's word before the daemon runs a command for the agent: resolves to run it, throws the refusal.
        // The daemon executes terminal/create itself, so this is the one check between the agent and the shell. Resolves
        // to the line the one command runner made of it (acp-terminal.ts acpTerminalShell), or undefined to run the
        // agent's own words.
        readonly admit: (request: CreateTerminalRequest) => Promise<PreparedTerminal | undefined>;
    };
}

// What a connection knows per session, beyond the turn bound to it, and what the routing reads.
export interface SessionRouting extends SessionOptions {
    readonly turns: Map<string, TurnHooks>;
    readonly abandoned: Set<string>;
    readonly modes: Map<string, SessionModes>;
    // What the agent says beyond the protocol (acp-events dialects): absent, plain ACP, and an extension the agent sends
    // is dropped, or refused as an unknown method, as before.
    readonly dialect?: { readonly speaks: AcpDialect; readonly reader: DialectReader };
}

// Every bound turn hears that the dialect read something, with the frames for its own session.
const deliver = (routing: SessionRouting, read: readonly { readonly sessionId: string; readonly events: readonly AgentEvent[] }[]): void => {
    for (const [sessionId, hooks] of routing.turns) {
        hooks.onFrames?.(read.flatMap((frames) => (frames.sessionId === sessionId ? frames.events : [])));
    }
};


const DECLINED: CreateElicitationResponse = { action: "decline" };

// An elicitation tied to a session; one tied to a request outside any session (an agent's own setup) names none.
const SessionScopeSchema = z.object({ sessionId: z.string() });

// The per-session routing every connection shares, the test fixture's included: a session's asks reach the turn bound
// to it. A late permission with no bound turn falls back to the standing auto-allow policy, unless the session was
// abandoned mid-turn; a form with no turn to show it on, or scoped to no session, is declined.
export const routeSessions = (app: ClientApp, routing: SessionRouting): ClientApp =>
    app
        // First of every handler: the SDK tries handlers in registration order, awaiting each, while a response settles
        // its request at once. An update the agent sent just before answering the prompt must land before the turn
        // reads the prompt as settled, so it has the fewest hops to go.
        .onNotification(methods.client.session.update, ({ params }) => {
            // Kept here rather than in a turn: an agent may restate its options or mode between turns, with none bound.
            if (params.update.sessionUpdate === "config_option_update") {
                recordOptions(routing, params.sessionId, params.update.configOptions);
            }
            if (params.update.sessionUpdate === "current_mode_update") {
                noteMode(routing.modes, params.sessionId, params.update.currentModeId);
            }
            if (routing.dialect === undefined) {
                routing.turns.get(params.sessionId)?.onUpdate(params);
                return;
            }
            const placed = placeUpdate(routing.dialect.reader, params);
            const hooks = routing.turns.get(placed.sessionId);
            hooks?.onUpdate(params, placed.child);
            if (placed.extra.length > 0) {
                hooks?.onFrames?.(placed.extra);
            }
        })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
            const hooks = routing.turns.get(params.sessionId);
            return hooks !== undefined ? hooks.permission(params) : decidePermission(params, "execute", routing.abandoned.has(params.sessionId));
        })
        .onRequest(methods.client.elicitation.create, ({ params }) => {
            const scope = SessionScopeSchema.safeParse(params);
            const elicit = scope.success ? routing.turns.get(scope.data.sessionId)?.elicit : undefined;
            return elicit === undefined ? DECLINED : elicit(params);
        })
        // What the agent sends beyond the protocol, read by its dialect; without one, or unread, dropped.
        .onNotification("*", ({ method, params }) => {
            // SAFETY: a JSON-RPC message's params arrived as JSON text, so they are JSON.
            const read = routing.dialect?.reader.notification(method, (params ?? null) as Json);
            if (read !== undefined) {
                deliver(routing, read);
            }
        })
        // A request of the agent's own: a question parks on the bound turn's card; anything else is an unknown method,
        // the answer the agent had before this fallback existed.
        .onRequest("*", ({ method, params }) => {
            // SAFETY: a JSON-RPC message's params arrived as JSON text, so they are JSON.
            const question = routing.dialect?.speaks.question?.(method, (params ?? null) as Json);
            if (question === undefined) {
                throw RequestError.methodNotFound(method);
            }
            const ask = routing.turns.get(question.sessionId)?.ask;
            return ask === undefined ? question.cancelled : ask(question);
        });


