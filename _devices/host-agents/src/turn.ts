import { pathToFileURL } from "node:url";
import {
    type ContentBlock,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    type PromptResponse,
    RequestError,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";
import { CANCELLED, personAnswer, type PersonDecision } from "@intentic/acp-events/answers";
import { ELICITATION_CANCELLED, ELICITATION_DECLINED, elicitationForm } from "@intentic/acp-events/elicitation";
import { sessionUpdateEvent } from "@intentic/acp-events/events";
import { offeredChoice, recordOptions, thoughtFor } from "@intentic/acp-events/model";
import { noteMode, planModeOf, recordModes, type SessionModes } from "@intentic/acp-events/modes";
import { sessionMissing } from "@intentic/acp-events/session-missing";
import { pathUnder } from "@intentic/acp-events/tool-cards";
import { promptUsage } from "@intentic/acp-events/usage";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import type { HarnessConnection } from "./connection.js";
import type { Run } from "./run.js";

// ONE TURN OVER A HARNESS'S CONNECTION: the session found or opened, its mode, model and effort settled, the prompt
// sent, and everything the agent says read into the chat's frames by the reading the sandbox daemon uses
// (@intentic/acp-events). The posture is not the daemon's: there, the container is the boundary and a turn may run
// without asking. Here nothing stands between the agent and the reader's own files, so every call the agent asks about
// goes to the reader on a card, and no turn is ever put in the agent's run-without-asking mode.

// What the protocol's auth_required refusal carries (-32000).
const AUTH_REQUIRED = RequestError.authRequired().code;

/** Whether a refusal says the harness is not signed in. */
export const needsSignIn = (error: RequestError): boolean => error.code === AUTH_REQUIRED;

// Lower-cased with punctuation and spacing dropped, as the shared mode reading compares names.
const normalized = (text: string): string => text.toLowerCase().replaceAll(/[^a-z0-9]/g, ``);
const named = (modes: SessionModes, names: ReadonlySet<string>): string | undefined =>
    modes.available.find((mode) => names.has(normalized(mode.id)) || names.has(normalized(mode.name)))?.id;

// The mode in which an agent asks before it changes anything, by the names harnesses give it (Claude Code's `default`,
// shown as Manual; Devin's `ask`).
const ASKS = new Set([`default`, `manual`, `ask`, `alwaysask`, `askbeforeedits`]);
// The mode in which it edits files without asking and still asks before it runs a command.
const ACCEPTS_EDITS = new Set([`acceptedits`, `autoedit`, `autoacceptedits`]);

/**
 * The agent's own mode for a turn's posture on this computer:
 * - `plan`: its read-only planning mode, where it has one;
 * - `bypassPermissions`: never its run-without-asking mode. The furthest a turn here goes is accepting file edits
 *   without a card each, where the agent has such a mode; commands are still asked about;
 * - `default`, or nothing named: the mode in which it asks first.
 * Without the mode asked for, the asking one; without that, the agent's own default as its session first stated it,
 * which the shared reading already keeps off any bypass or plan mode.
 */
export const hostModeFor = (modes: SessionModes, permissionMode: PermissionMode | undefined): string => {
    const asks = named(modes, ASKS) ?? modes.home;
    if (permissionMode === `plan`) {
        return planModeOf(modes) ?? asks;
    }
    return permissionMode === `bypassPermissions` ? (named(modes, ACCEPTS_EDITS) ?? asks) : asks;
};

export interface TurnAsk {
    readonly conversationId: string;
    readonly prompt: string;
    // Files that go with the words, as paths in the harness's place.
    readonly attachments: readonly string[];
    readonly sessionId: string | undefined;
    // The folder the harness works in, as its own place names it.
    readonly cwd: string;
    // The platform of that place: how its paths are read.
    readonly platform: NodeJS.Platform;
    readonly model: string | undefined;
    readonly effort: string | undefined;
    readonly permissionMode: PermissionMode | undefined;
    readonly signal: AbortSignal;
    // Told the session the turn runs on as soon as it is known, so a stop or a restart can name it.
    readonly onSession: (sessionId: string) => void;
    // A fresh request id for a card.
    readonly mintId: () => string;
}

export interface TurnOutcome {
    readonly sessionId: string | undefined;
    readonly ending: `settled` | `stopped` | `failed`;
    // Set on `failed` when the harness is not signed in: the reader's next step is a sign-in, not a retry.
    readonly signIn?: true;
}

const SESSION_TIMEOUT_MS = 60_000;
// How long a stopped turn waits for the agent to settle its prompt after the cancel, which is only a notice.
const STOP_GRACE_MS = 5_000;

// The session a turn runs on: the one this process already serves, the conversation's own resumed, or a new one. A
// session the harness no longer has is let go and a fresh one opened, said in the transcript: the rows stay, the agent's
// own memory of them does not.
const sessionFor = async (connection: HarnessConnection, ask: TurnAsk, publish: (event: AgentEvent) => void): Promise<string> => {
    const { agent, capabilities, sessions } = connection;
    const kept = ask.sessionId;
    if (kept !== undefined && sessions.has(kept)) {
        return kept;
    }
    if (kept !== undefined) {
        try {
            // `resume` reattaches without replaying the conversation; `load` replays it as updates, which reach no turn
            // (none is bound yet) and are dropped, the rows being this side's own already.
            if (capabilities.sessionCapabilities?.resume != null) {
                const resumed = await agent.request(methods.agent.session.resume, { sessionId: kept, cwd: ask.cwd, mcpServers: [] });
                recordModes(connection.modes, kept, resumed.modes);
                recordOptions(connection, kept, resumed.configOptions);
                sessions.add(kept);
                return kept;
            }
            if (capabilities.loadSession === true) {
                const loaded = await agent.request(methods.agent.session.load, { sessionId: kept, cwd: ask.cwd, mcpServers: [] });
                recordModes(connection.modes, kept, loaded.modes);
                recordOptions(connection, kept, loaded.configOptions);
                sessions.add(kept);
                return kept;
            }
        } catch (error) {
            if (!(error instanceof RequestError) || !sessionMissing(error)) {
                throw error;
            }
        }
        publish({
            kind: `agent_notice`,
            level: `warning`,
            text: `The agent no longer has this conversation's session, so it starts this turn without its memory of the earlier ones.`,
        });
    }
    const opened = await agent.request(methods.agent.session.new, { cwd: ask.cwd, mcpServers: [] });
    recordModes(connection.modes, opened.sessionId, opened.modes);
    recordOptions(connection, opened.sessionId, opened.configOptions);
    sessions.add(opened.sessionId);
    return opened.sessionId;
};

// The turn's model and effort, where the agent offers the choice and the one asked for is among them. One it does not
// offer is left as the agent has it: the picker lists the agent's own choices, so this is a model it since withdrew.
const settleOptions = async (connection: HarnessConnection, sessionId: string, ask: TurnAsk): Promise<string | undefined> => {
    const set = async (configId: string, value: string): Promise<void> => {
        const answered = await connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
        recordOptions(connection, sessionId, answered.configOptions);
    };
    const models = connection.models.get(sessionId);
    const wanted = models === undefined || ask.model === undefined ? undefined : offeredChoice(models, ask.model);
    if (models !== undefined && wanted !== undefined && wanted !== models.current) {
        await set(models.configId, wanted);
    }
    const thoughts = connection.thoughts.get(sessionId);
    const depth = thoughts === undefined || ask.effort === undefined ? undefined : thoughtFor(thoughts, ask.effort);
    if (thoughts !== undefined && depth !== undefined && depth !== thoughts.current) {
        await set(thoughts.configId, depth);
    }
    return connection.models.get(sessionId)?.current ?? ask.model;
};

const settleMode = async (connection: HarnessConnection, sessionId: string, permissionMode: PermissionMode | undefined): Promise<void> => {
    const modes = connection.modes.get(sessionId);
    if (modes === undefined) {
        return;
    }
    const target = hostModeFor(modes, permissionMode);
    if (target !== modes.current) {
        await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: target });
        noteMode(connection.modes, sessionId, target);
    }
};

const promptBlocks = (ask: TurnAsk): ContentBlock[] => [
    { type: `text`, text: ask.prompt },
    ...ask.attachments.map(
        (path): ContentBlock => ({
            type: `resource_link`,
            uri: ask.platform === process.platform ? pathToFileURL(path).href : `file://${path}`,
            name: path.split(/[\\/]/).at(-1) ?? path,
        }),
    ),
];

// The card for one call the agent asks about: its own title for the call, the file it concerns, and an "always" only
// where the agent offered one to remember.
const permissionFrame = (asked: RequestPermissionRequest, requestId: string, path: string | undefined): Extract<AgentEvent, { kind: `permission` }> => {
    const toolName = asked.toolCall.title ?? asked.toolCall.kind ?? `tool`;
    const card: Extract<AgentEvent, { kind: `permission` }> = {
        kind: `permission`,
        requestId,
        toolName,
        reason: `Nothing on this computer is sandboxed, so the agent asks before it acts.`,
    };
    if (path !== undefined) {
        card.path = path;
    }
    if (asked.options.some((option) => option.kind === `allow_always`)) {
        card.alwaysLabel = `Don't ask again for ${toolName}`;
    }
    return card;
};

type PermissionReply = Extract<AgentReply, { kind: `permission` }>;
const decisionOf = (reply: PermissionReply): PersonDecision => (reply.decision === `deny` ? `deny` : reply.decision === `always` ? `always` : `once`);

const askPermission =
    (ask: TurnAsk, run: Run, standing: { everything: boolean }) =>
    async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        if (ask.signal.aborted) {
            return CANCELLED;
        }
        // The reader already said yes to everything this turn asks.
        if (standing.everything) {
            return personAnswer(request, `once`);
        }
        const requestId = ask.mintId();
        const location = request.toolCall.locations?.[0]?.path;
        run.publish(permissionFrame(request, requestId, location === undefined ? undefined : pathUnder(location, ask.cwd)));
        const reply = await run.park(requestId);
        if (reply?.kind !== `permission`) {
            run.publish({ kind: `resolved`, requestId });
            return CANCELLED;
        }
        run.publish({ kind: `resolved`, requestId, reply });
        standing.everything ||= reply.decision === `everything`;
        return personAnswer(request, decisionOf(reply));
    };

// A form the agent asks the reader to fill, on the question card every runtime shares.
const askForm =
    (ask: TurnAsk, run: Run) =>
    async (request: CreateElicitationRequest): Promise<CreateElicitationResponse> => {
        const form = elicitationForm(request);
        if (form === undefined) {
            return ELICITATION_DECLINED;
        }
        const requestId = ask.mintId();
        run.publish({ kind: `question`, requestId, questions: [...form.questions] });
        const reply = await run.park(requestId);
        if (reply?.kind !== `question`) {
            run.publish({ kind: `resolved`, requestId });
            return ELICITATION_CANCELLED;
        }
        run.publish({ kind: `resolved`, requestId, reply });
        return form.answer(reply);
    };

// What a refusal carries beside its headline: the protocol's own errors say "Internal error" and put the agent's words
// in `data`.
const RefusalDataSchema = z.union([z.string().min(1), z.looseObject({ details: z.string().min(1) }).transform((data) => data.details), z.looseObject({ message: z.string().min(1) }).transform((data) => data.message)]);
const wordsOf = (error: unknown): string => {
    const said = errorMessage(error);
    const more = error instanceof RequestError ? RefusalDataSchema.safeParse(error.data) : undefined;
    return more?.success === true && more.data !== said ? `${said}: ${more.data}` : said;
};

const failureWords = (said: string, connection: HarnessConnection): string => {
    const tail = connection.alive() ? `` : connection.stderrTail().trim().split(`\n`).slice(-3).join(`\n`);
    return tail === `` ? said : `${said}\n${tail}`;
};

/** Runs one turn to its end, publishing every frame into `run`. Never throws: a failure is the turn's last frame. */
export const runTurn = async (connection: HarnessConnection, ask: TurnAsk, run: Run): Promise<TurnOutcome> => {
    let sessionId = ask.sessionId;
    const publish = (event: AgentEvent): void => run.publish(event);
    try {
        sessionId = await Promise.race([
            sessionFor(connection, ask, publish),
            sleep(SESSION_TIMEOUT_MS, { unref: true }).then((): never => {
                throw new Error(`The agent did not open a session within a minute.`);
            }),
        ]);
        ask.onSession(sessionId);
        publish({ kind: `session`, sessionId });
        const model = await settleOptions(connection, sessionId, ask);
        await settleMode(connection, sessionId, ask.permissionMode);
        if (model !== undefined) {
            publish({ kind: `init`, model });
        }
    } catch (error) {
        if (error instanceof RequestError && needsSignIn(error)) {
            publish({ kind: `error`, code: `acp-auth-required`, own: true, message: `This agent isn't signed in on this computer yet.` });
            return { sessionId, ending: `failed`, signIn: true };
        }
        publish({ kind: `error`, message: failureWords(wordsOf(error), connection) });
        return { sessionId, ending: `failed` };
    }
    const session = sessionId;
    const standing = { everything: false };
    const unbind = connection.bindTurn(session, {
        onUpdate: ({ update }) => {
            // Paths are read against the folder as its own place names it (a distro's are POSIX while this process is
            // Windows'), which the shared reading tells from the folder's shape.
            const event = sessionUpdateEvent(update, ask.cwd);
            if (event !== undefined) {
                publish(event);
            }
        },
        permission: askPermission(ask, run, standing),
        elicit: askForm(ask, run),
    });
    // The cancel is a notice: the prompt settles when the agent has stopped, or the grace below gives up on it.
    const cancel = (): void => {
        // allow(silent-catch): a cancel refused is a turn already over; the grace ends the wait either way.
        void connection.agent.notify(methods.agent.session.cancel, { sessionId: session }).catch(() => undefined);
    };
    ask.signal.addEventListener(`abort`, cancel, { once: true });
    if (ask.signal.aborted) {
        cancel();
    }
    try {
        const prompted = connection.agent.request(methods.agent.session.prompt, { sessionId: session, prompt: promptBlocks(ask) });
        const stopped = new Promise<`gave-up`>((resolve) => {
            ask.signal.addEventListener(`abort`, () => void sleep(STOP_GRACE_MS, { unref: true }).then(() => resolve(`gave-up`)), { once: true });
        });
        const response: PromptResponse | `gave-up` = await Promise.race([prompted, stopped]);
        if (response === `gave-up`) {
            // The agent never settled its prompt: its process is every conversation's on this harness, so it is left
            // running and only this session's turn is let go.
            // allow(silent-catch): the abandoned prompt's own ending, whenever it comes, is nobody's to read.
            void prompted.catch(() => undefined);
            return { sessionId: session, ending: `stopped` };
        }
        const used = promptUsage(connection, session, response);
        if (used !== undefined) {
            publish(used);
        }
        return { sessionId: session, ending: ask.signal.aborted || response.stopReason === `cancelled` ? `stopped` : `settled` };
    } catch (error) {
        if (ask.signal.aborted) {
            return { sessionId: session, ending: `stopped` };
        }
        if (error instanceof RequestError && needsSignIn(error)) {
            publish({ kind: `error`, code: `acp-auth-required`, own: true, message: `This agent isn't signed in on this computer yet.` });
            return { sessionId: session, ending: `failed`, signIn: true };
        }
        publish({ kind: `error`, message: failureWords(wordsOf(error), connection) });
        return { sessionId: session, ending: `failed` };
    } finally {
        ask.signal.removeEventListener(`abort`, cancel);
        unbind();
    }
};
