import type {
    ClientApp,
    CreateElicitationRequest,
    CreateElicitationResponse,
    CreateTerminalRequest,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionNotification,
} from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { decidePermission } from "./acp-permissions.js";
import { recordOptions, type SessionOptions } from "./acp-model.js";
import { noteMode, type SessionModes } from "./acp-modes.js";

// How a connection hands each session's traffic to the turn bound to it, kept apart from the process that carries it
// (acp-connection.ts) so the in-process test fixture routes exactly the same way without a spawn.

export interface TurnHooks {
    readonly onUpdate: (notification: SessionNotification) => void;
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
        // The daemon executes terminal/create itself, so this is the one check between the agent and the shell.
        readonly admit: (request: CreateTerminalRequest) => Promise<void>;
    };
}

// What a connection knows per session, beyond the turn bound to it, and what the routing reads.
export interface SessionRouting extends SessionOptions {
    readonly turns: Map<string, TurnHooks>;
    readonly abandoned: Set<string>;
    readonly modes: Map<string, SessionModes>;
}

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
            routing.turns.get(params.sessionId)?.onUpdate(params);
        })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
            const hooks = routing.turns.get(params.sessionId);
            return hooks !== undefined ? hooks.permission(params) : decidePermission(params, "execute", routing.abandoned.has(params.sessionId));
        })
        .onRequest(methods.client.elicitation.create, ({ params }) => {
            const scope = SessionScopeSchema.safeParse(params);
            const elicit = scope.success ? routing.turns.get(scope.data.sessionId)?.elicit : undefined;
            return elicit === undefined ? DECLINED : elicit(params);
        });


