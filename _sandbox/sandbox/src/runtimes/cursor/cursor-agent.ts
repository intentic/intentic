import { vendorShellEnv } from "../../agent/run/vendor-shell-env.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentOptions, McpServerConfig as CursorMcpServer, ModelSelection, RunError, SDKCustomTool, SendOptions } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { whenAborted } from "@intentic/base/async";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import { mentionsSpentAllowance } from "../../agent/providers/failure-sentences.js";
import type { AgentRequest, CursorCredential } from "../../agent/providers/agent-request.js";
import { EventQueue } from "../../agent/run/event-queue.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import type { CursorCatalog } from "./models/cursor-catalog.js";
import { createCursorEventMapper } from "./cursor-events.js";
import { type CursorRunHandle, type CursorSession, inProcessHost, namespacedHost, type NamespacedHostInput } from "./cursor-host.js";
import { type CursorGateTurn, type CursorHookService, LIST_HOOKS } from "./cursor-hooks.js";
import { opt } from "../../opt.js";
import { selectionFor } from "./models/cursor-models.js";
import { CURSOR_SDK_MISSING, cursorSdk, cursorSdkEntry } from "./cursor-sdk.js";
import { cursorCustomTools, cursorMcpServers, TOOLS_WITHHELD } from "./cursor-tools.js";
import { type CursorOwner, cursorOwner } from "./turn/cursor-approvals.js";
import { cursorSecrets, secretMaskedCustomTools } from "./turn/cursor-secrets.js";
import { type CursorSkills, NO_SKILLS, projectKit } from "./turn/cursor-skills.js";
import { cursorTerminalOf } from "./turn/cursor-terminal.js";
import { cursorToolsOption, listedCustomTools, listedMcpServers } from "./turn/cursor-tool-list.js";
import { cursorCommands, type CursorCommand, expandCursorCommand } from "./cursor-commands.js";
import type { TurnShield } from "../../privacy/privacy-shield.js";
import {
    CURSOR_SHIELD_NOTE,
    createEventRestorer,
    cursorHookShield,
    instructionRefusal,
    SHIELD_WITHHELD,
    shieldedCustomTools,
    projectMcp,
    shieldedSession,
    UnmaskedMessage,
} from "./cursor-shield.js";

// Cursor provider adapter: same AgentRequest-in/AgentEvent-out seam as createCodexAgent/createOpenCodeAgent/runPiAgent,
// over @cursor/sdk's local agent runtime. The loop runs in this process, so the daemon's own functions can be tools; the
// SDK agent itself runs here too, except for a turn anchored in a mount namespace, whose agent runs in a runtime process
// born there (cursor-host.ts) and reaches those same tools back over its channel. Reads only the delta stream from
// `send({ onDelta })`, not the overlapping `run.stream()`.

export interface CursorAgentDeps {
    readonly catalog: CursorCatalog;
    readonly hooks: CursorHookService;
    readonly logger: Logger;
    // How an anchored turn's runtime process is started; a suite stands in for the process here.
    readonly runtime?: Pick<NamespacedHostInput, "spawn" | "command">;
}

// Grace period for a cancel to unwind Cursor's tool calls before frames stop; a request, not a kill.
const CANCEL_GRACE_MS = 5_000;

// How long a phase waits for its first delta before calling the run stalled. Bounds the opening only: once deltas flow,
// a silent gap is a tool call running long, and a cap there would end working turns.
export const FIRST_DELTA_MS = 5 * 60_000;

// Coded like a 5xx so the outage breaker queues the turn and resumes it on its own session, rather than stranding it.
const CURSOR_STALLED = "Cursor took the turn and then sent nothing at all; treating the provider as unavailable.";

// An account the server does not let replace Cursor's base prompt: `systemPrompt` is entitlement-gated, and an account
// without it is refused with an InvalidArgument naming --system-prompt on its first send (options.d.ts). Thrown out of
// the turn so it is run again on the append path; `agentId` is the agent the refused send opened, resumed by the retry.
class SystemPromptRefused extends Error {
    agentId: string | undefined;
}

// Whether a failed send is that refusal: the only failure that names the flag.
const refusesSystemPrompt = (message: string | undefined): boolean => message !== undefined && /system[-_ ]?prompt/i.test(message);

// What a turn tells Cursor beyond its prompt, and whether the replacing half was taken: set by the first delta of a
// send that carried it, which is the account's entitlement answered.
interface TurnInstructions {
    readonly replacing: boolean;
    accepted: boolean;
}

// Throws SystemPromptRefused when a send that carried the replacement failed before Cursor said anything, naming it.
const refusedReplacement = (
    instructions: TurnInstructions,
    sawDelta: boolean,
    sendError: unknown,
    result: { readonly status?: string; readonly error?: { readonly message?: string } } | undefined,
): void => {
    if (!instructions.replacing || sawDelta) {
        return;
    }
    const failure = sendError instanceof Error ? sendError.message : result?.status === "error" ? result.error?.message : undefined;
    if (refusesSystemPrompt(failure)) {
        throw new SystemPromptRefused(failure);
    }
};

const nonBlank = (text: string | undefined): string | undefined => (text === undefined || text.trim() === "" ? undefined : text);

// The account an entitlement is remembered for: its key, hashed, since the key itself is a credential.
const accountOf = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

// What a turn says to Cursor: the project's own commands (cursor-commands.ts), read off the tree Cursor opens (an anchored
// turn's as its namespace sees it), with a message that opens with one sent as its text; and the instructions. The
// owner's replacement rides `systemPrompt` where the account may replace Cursor's base and folds onto the append with the
// rest where it may not, the append being the seam every account reaches. A sealed request has neither: its system
// prompt rides in front of its words (sealedOptions).
const turnWords = async (
    request: AgentRequest<CursorCredential>,
    instructions: TurnInstructions,
): Promise<{
    readonly commands: readonly CursorCommand[];
    readonly words: string;
    readonly told: { readonly replace: string | undefined; readonly append: string | undefined };
}> => {
    if (request.policy.sealed === true) {
        const system = nonBlank(request.spec.systemPrompt);
        return { commands: [], words: system === undefined ? request.spec.prompt : `${system}\n\n${request.spec.prompt}`, told: { replace: undefined, append: undefined } };
    }
    const anchor = request.spec.isolation?.anchor;
    const commands = await cursorCommands(anchor === undefined ? request.spec.cwd : join("/proc", String(anchor.pid), "root", request.spec.cwd));
    const replace = nonBlank(request.spec.systemPrompt);
    const append = nonBlank(request.spec.systemAppend);
    const told = instructions.replacing ? { replace, append } : { replace: undefined, append: nonBlank([replace, append].filter((part) => part !== undefined).join("\n\n")) };
    return { commands, words: expandCursorCommand(request.spec.prompt, commands), told };
};

// Maps everything the SDK can throw to the coded error frames auto-resume/reconnect already key off, matched by the
// SDK's exported error classes, not message text (which is not public API).
const codedError = async (error: unknown, sdk: Awaited<ReturnType<typeof cursorSdk>>): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const message = error instanceof Error && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (error instanceof UnmaskedMessage) {
        return { kind: "error", message, code: "privacy-unshielded" };
    }
    if (sdk === undefined) {
        return { kind: "error", message };
    }
    if (error instanceof sdk.RateLimitError) {
        return { kind: "error", message, code: "rate_limit" };
    }
    if (error instanceof sdk.AuthenticationError) {
        // Not subscription-required: account is connected, the key stopped working; fix is re-signing the same row.
        return { kind: "error", message: `${message} Connect your Cursor account again in Sandbox ▸ Agent.` };
    }
    if (error instanceof sdk.AgentBusyError) {
        return { kind: "error", message, code: "agent-busy" };
    }
    if (error instanceof sdk.AgentNotFoundError) {
        // This machine lost the named agent (store cleared, a rebuild); client drops it, next send opens fresh.
        return { kind: "error", message, code: "session-not-found" };
    }
    // UnknownAgentError is deliberately not matched above: it is the SDK's catch-all for any error it cannot classify
    // (its converter ends in `new UnknownAgentError(message)`), not "unknown agent". Coding it session-not-found hid
    // real failures as a silently dropped session, the wedged "already has active run" among them.
    if (error instanceof sdk.NetworkError) {
        return { kind: "error", message, code: "provider-outage" };
    }
    return { kind: "error", message };
};

// What a run's own terminal error calls a spent allowance, in the SDK's code vocabulary (errors.js maps Connect's
// ResourceExhausted to `resource_exhausted`; the agent store's own quota uses `quota_exceeded`). Matched beside the
// sentence, since the code is the one half that survives a reworded message.
const EXHAUSTED_RUN_CODES: ReadonlySet<string> = new Set(["resource_exhausted", "rate_limit", "quota_exceeded", "usage_limit"]);

// A run that ENDED in error, as against one whose send threw: Cursor reports a spent plan this way, and `RateLimitError`
// is reserved for an HTTP 429, so nothing above ever sees it. Classified here instead of going out bare, which is what
// cost seven refused subagent turns their record in the observed-limit ledger, their hold and their re-run
// (2026-10-13). Only a spent allowance is coded: an unknown vendor code must not become a daemon code, and the message
// carries it to the log either way.
export const cursorRunErrorFrame = (error: RunError | undefined): Extract<AgentEvent, { kind: "error" }> => {
    const message = error?.message !== undefined && error.message !== "" ? error.message : "The Cursor turn failed.";
    const spent = mentionsSpentAllowance(message) || (error?.code !== undefined && EXHAUSTED_RUN_CODES.has(error.code));
    return spent ? { kind: "error", message, code: "rate_limit" } : { kind: "error", message };
};

// A sealed request's agent (agent-request.ts `policy.sealed`): its prompt is everything the model reads, so no tool is
// offered, no MCP server or custom tool mounted, and no setting source read, the command gate's included, since nothing
// can run for it to gate. An empty allowlist rather than a denylist: an unknown tool name in disallowedTools makes
// Agent.create reject outright.
const sealedOptions = (model: ModelSelection, apiKey: string, cwd: string): AgentOptions => ({
    model,
    apiKey,
    tools: [],
    local: { cwd, settingSources: [] },
});

// Ends one phase's drain without ending the turn's queue: a plan turn runs two phases, and the tools that push into it
// were bound to it once, when the agent was created.
const PHASE_END = Symbol("cursor-phase-end");
type PhaseItem = AgentEvent | typeof PHASE_END;

// Cursor's `plan` mode is read-only by the runtime's own enforcement; `agent` is the full toolbox. Every other posture
// this repo asks for collapses onto `agent`: finer approvals are the command rulebook's job, not a mode.
const modeFor = (planning: boolean): "plan" | "agent" => (planning ? "plan" : "agent");

// Mid-turn injection rides the live Run, not the prompt, so the pump waits for the handle `send` resolves rather than
// racing it. Only `complete_delivered` transfers ownership. Any other answer (`revert_to_followup`, a refused steer, a
// run with no `steer` at all) hands the message back, and the relay has already let it go, so the pump keeps it and the
// phase sends it as an ordinary follow-up once the run settles: the SDK's own instruction, and what Codex does with a
// steer its app-server refuses. `Run.steer` is declared optional by the SDK, so CursorRunHandle carries it optionally
// too.

// Best-effort: the phase ends on its own timer, so a cancel the SDK refuses is only worth a trace.
const cancelRun = async (started: Promise<CursorRunHandle | undefined>, logger: Logger): Promise<void> => {
    const handle = await started;
    try {
        await handle?.cancel();
    } catch (error) {
        logger.debug({ err: error }, "cursor: run cancel refused");
    }
};

// Answers, once the channel closes, every message the run handed back, in the order they were typed.
const steerInto = async (
    started: Promise<CursorRunHandle | undefined>,
    channel: SteeringChannel,
    settled: () => boolean,
    logger: Logger,
): Promise<readonly string[]> => {
    const handedBack: string[] = [];
    for await (const text of channel.steering) {
        const run = await started;
        // A run that has already settled can take nothing, so it is not asked. On a shielded turn the run masks what it
        // is steered with (shieldedSession), and a message it could not mask is refused here and handed back.
        const outcome = settled()
            ? undefined
            : await run?.steer?.(text).catch((error: unknown) => {
                  logger.warn({ err: error }, "cursor: steering message rejected by the run");
                  return undefined;
              });
        if (outcome !== "complete_delivered") {
            handedBack.push(text);
        }
    }
    return handedBack;
};

// Said when a turn carries a tool list but the hooks that hold Cursor to it are not in place: past the built-in tools its
// header restricts, nothing would check a narrowed shell command or an MCP server's tool against the list.
const CURSOR_LIST_HOOKS_MISSING =
    "This turn may use only some tools, and the hooks that hold Cursor to that list are not installed in this sandbox, so it was not started. Restart the sandbox to reinstall them.";

// What a Cursor turn is handed beside its request, worked out where the turn is planned (cursor-provider.ts).
export interface CursorTurnExtras {
    readonly skills?: CursorSkills;
}

// The plan card, run by the daemon's two phases with Cursor's own read-only plan mode under the first: Cursor has no
// approval step of its own between a plan and its execution, whatever its row says about the other modes.
const PLAN_EMULATED = { permissions: "plan" } as const;

// Said when the shield reads a turn but its hooks into Cursor are not in place (cursor-hooks.ts could not write the
// hooks file, or another daemon took it): with no hook in front of a read, a turn would run unread past its prompt.
const CURSOR_HOOKS_MISSING =
    "The privacy shield could not read this turn: its hooks into Cursor are not installed in this sandbox, so Cursor's file reads and commands would go to Cursor unchecked. Restart the sandbox to reinstall them, or let Cursor read this conversation as it is.";

// A shielded turn's opening (cursor-shield.ts): refused when the shield's hooks are not in place, or when the rules
// Cursor loads itself hold personal data; otherwise the instructions as the model may read them, masked while the
// shield masks, with the note that tells the model what a token is and where its tools stand. The prompt is not masked
// here: every message the turn sends is masked by its session (shieldedSession).
const shieldedStart = async (
    shield: TurnShield,
    request: AgentRequest<CursorCredential>,
    anchor: { readonly pid: number } | undefined,
    told: { readonly replace: string | undefined; readonly append: string | undefined },
): Promise<
    | { readonly refused: Extract<AgentEvent, { kind: "error" }> }
    | {
          readonly replace: string | undefined;
          readonly append: string | undefined;
          readonly masking: boolean;
          // The project's MCP servers through the masking proxy, or `withhold`: the project's settings not loaded at all.
          readonly project: Awaited<ReturnType<typeof projectMcp>>;
      }
> => {
    try {
        // An anchored turn's folder as its namespace sees it, which is the tree Cursor's own rule loader reads.
        const root = anchor === undefined ? request.spec.cwd : join("/proc", String(anchor.pid), "root", request.spec.cwd);
        const instructions = await instructionRefusal(shield, root, "Cursor");
        if (instructions !== undefined) {
            return { refused: { kind: "error", code: "privacy-instructions", message: instructions } };
        }
        const masking = await shield.masking();
        const own = told.append === undefined ? undefined : await shield.mask(told.append, "instructions");
        const replace = told.replace === undefined ? undefined : await shield.mask(told.replace, "instructions");
        const append = masking ? (own === undefined ? CURSOR_SHIELD_NOTE : `${own}\n\n${CURSOR_SHIELD_NOTE}`) : own;
        return { replace, append, masking, project: await projectMcp(shield, root) };
    } catch (error) {
        const message = `The privacy shield could not read this turn, so it was not sent to Cursor. ${error instanceof Error ? error.message : ""}`.trim();
        return { refused: { kind: "error", code: "privacy-unshielded", message } };
    }
};

// Every MCP server the turn mounts, reached through the privacy shield's masking proxy instead (gateway/mcp-route.ts);
// its own headers ride along, so the server sees the bearer it always did.
const proxiedMcpServers = async (servers: Record<string, CursorMcpServer>, shield: TurnShield): Promise<Record<string, CursorMcpServer>> =>
    Object.fromEntries(
        await Promise.all(
            Object.entries(servers).map(async ([name, server]) => [name, "url" in server ? { ...server, url: await shield.mcpUrl(server.url) } : server] as const),
        ),
    );

// Whether the hooks that hold Cursor to a tool list are in place (cursor-hooks.ts LIST_HOOKS).
const listHeld = async (hooks: CursorHookService): Promise<boolean> =>
    // allow(silent-catch): hooks that cannot be read are hooks that do not cover the turn, which the caller refuses.
    hooks.ready() && (await hooks.covers(LIST_HOOKS).catch(() => false));

// A shielded turn's opening, once the shield let it through.
type ShieldedOpening = Exclude<Awaited<ReturnType<typeof shieldedStart>>, { readonly refused: unknown }>;

// What a turn's agent options are built from beyond its request.
interface TurnOptionsInput {
    readonly request: AgentRequest<CursorCredential>;
    readonly selection: ModelSelection;
    readonly systemPrompt: string | undefined;
    readonly shield: TurnShield | undefined;
    readonly shielded: ShieldedOpening | undefined;
    readonly list: readonly string[] | undefined;
    readonly customTools: Record<string, SDKCustomTool>;
    readonly mcpServers: Record<string, CursorMcpServer>;
    // Workspace roots beyond the cwd, which Cursor loads skills and rules from too (cursor-skills.ts).
    readonly dirs: readonly string[];
    readonly logger: Logger;
}

// The agent's options for one turn.
const turnOptions = async (input: TurnOptionsInput): Promise<AgentOptions> => {
    const { request, shield, shielded, list, customTools, mcpServers } = input;
    if (request.policy.sealed === true) {
        return sealedOptions(input.selection, request.credential.apiKey, request.spec.cwd);
    }
    // Cursor starts the project's own MCP servers with its project settings, unproxied: each is given again under its
    // name through the proxy, or, where one can't be, the project's settings are not loaded on this turn at all.
    const project = shielded?.project;
    const withheldProject = project !== undefined && "withhold" in project;
    if (withheldProject) {
        input.logger.warn(
            { servers: project.withhold },
            "cursor: the project's MCP servers can't all be reached through the privacy shield, so its project settings are not loaded on this turn",
        );
    }
    const projectServers = project !== undefined && "servers" in project ? project.servers : {};
    return {
        model: input.selection,
        apiKey: request.credential.apiKey,
        // Not persisted on the agent, so every turn passes it again (options.d.ts).
        ...opt("systemPrompt", input.systemPrompt),
        // Deny-wins with the withheld list below (options.d.ts): a tool must be on the list and not withheld.
        ...opt("tools", list === undefined ? undefined : cursorToolsOption(list)),
        disallowedTools: shielded?.masking === true ? [...TOOLS_WITHHELD, ...SHIELD_WITHHELD] : [...TOOLS_WITHHELD],
        local: {
            cwd: request.spec.cwd,
            ...opt("dirs", input.dirs.length > 0 ? [...input.dirs] : undefined),
            // mdm carries the command gate (cursor-hooks.ts); user is skipped, it also reads this daemon's Claude
            // settings; project is skipped on a shielded turn whose MCP servers can't be proxied.
            settingSources: withheldProject ? ["mdm"] : ["mdm", "project"],
            customTools: shield === undefined ? customTools : shieldedCustomTools(customTools, shield),
            // Every `Task` child is sent the same tool headers as the main loop (the list, and the tools withheld
            // above), which without this it is not: a child keeps its own curated toolset.
            subagentInherit: {},
        },
        mcpServers: shield === undefined ? mcpServers : { ...projectServers, ...(await proxiedMcpServers(mcpServers, shield)) },
    };
};

// What the hook service holds for one live turn (cursor-hooks.ts).
const hookTurn = (input: {
    readonly agentId: string;
    readonly request: AgentRequest<CursorCredential>;
    readonly shellEnv: Record<string, string>;
    readonly systemAppend: string | undefined;
    readonly gate: CursorGateTurn["gate"];
    readonly push: (event: AgentEvent) => void;
    readonly shield: TurnShield | undefined;
    readonly list: readonly string[] | undefined;
    readonly owner: CursorOwner | undefined;
    readonly skills: CursorSkills | undefined;
}): CursorGateTurn => {
    const { request, shellEnv, skills } = input;
    return {
        conversationId: input.agentId,
        ...opt("cliEnv", Object.keys(shellEnv).length > 0 ? shellEnv : undefined),
        ...opt("systemAppend", input.systemAppend),
        gate: input.gate,
        push: input.push,
        ...opt("shield", input.shield === undefined ? undefined : cursorHookShield(input.shield)),
        ...opt("allowedTools", input.list),
        ...opt("secrets", request.tools.secrets === undefined ? undefined : cursorSecrets(request.tools.secrets)),
        // The shell in the terminal panel; the session is named from Cursor's agent id, as the conversation's is.
        ...opt("terminal", cursorTerminalOf(input.agentId, { envKeys: Object.keys(shellEnv), isolation: request.spec.isolation, owner: request.spec.conversationId })),
        ...opt("owner", input.owner),
        ...opt("deniedSkills", skills === undefined || skills.denied.length === 0 ? undefined : skills.denied),
    };
};

// How one send of a phase ended, and the steering messages its run handed back, known once the phase's channel closes.
interface PhaseOutcome {
    readonly errored: boolean;
    readonly planText: string | undefined;
    readonly handedBack: Promise<readonly string[]>;
}

export const createCursorAgent = (deps: CursorAgentDeps) => {
    // Forwards one phase of the turn's queue; the caller emits `done` once, since a plan turn runs two of these.
    // While planning, the assistant's prose is captured, not streamed, becoming the plan text.
    async function* runPhase(
        agent: CursorSession,
        request: AgentRequest,
        queue: EventQueue<PhaseItem>,
        prompt: string,
        selection: ModelSelection | undefined,
        planning: boolean,
        channel: SteeringChannel | undefined,
        force: boolean,
        shield: TurnShield | undefined,
        instructions: TurnInstructions,
    ): AsyncGenerator<AgentEvent, PhaseOutcome> {
        const mapper = createCursorEventMapper(request.spec.cwd, planning);
        // Tokens the model writes, read back before the transcript shows them; absent while the shield reads nothing.
        const restorer = shield === undefined ? undefined : createEventRestorer(shield.restore);
        let sawDelta = false;
        const options: SendOptions = {
            mode: modeFor(planning),
            ...(selection !== undefined ? { model: selection } : {}),
            // Only `force` rides the per-send `local`; custom tools not named here fall back to the agent's own.
            ...(force ? { local: { force: true } } : {}),
            // Mapped where it arrives rather than where it is read: the drain below can be parked on a tool handler,
            // and what the mapper captures is read the moment the phase ends.
            onDelta: ({ update }) => {
                sawDelta = true;
                instructions.accepted ||= instructions.replacing;
                for (const frame of mapper.map(update)) {
                    for (const shown of restorer === undefined ? [frame] : restorer.map(frame)) {
                        queue.push(shown);
                    }
                }
            },
        };

        // Once per phase, however many of the three ways to end one fire; a second sentinel would end the next phase
        // before it had streamed anything.
        let ended = false;
        const endPhase = (): void => {
            if (ended) {
                return;
            }
            ended = true;
            queue.push(PHASE_END);
        };

        let sendError: unknown;
        // Not awaited: frames arrive via onDelta while this resolves; awaiting first would buffer the turn's opening.
        const started: Promise<CursorRunHandle | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            endPhase();
            return undefined;
        });

        // Covers both silences the SDK can hold a turn in: a `send` that never resolves, and a run that resolves and
        // then never deltas. Cancel is best-effort, so the phase ends on this timer rather than on the cancel.
        let stalled = false;
        const stall = setTimeout(() => {
            if (sawDelta) {
                return;
            }
            stalled = true;
            void cancelRun(started, deps.logger);
            endPhase();
        }, FIRST_DELTA_MS);
        stall.unref();

        // Stop cancels the run instead of abandoning it, so Cursor unwinds tool calls and the transcript ends resolved.
        const onAbort = (): void => {
            void cancelRun(started, deps.logger);
            setTimeout(endPhase, CANCEL_GRACE_MS).unref();
        };
        // A pre-pull Stop hits an aborted signal no listener catches; unwatched, send starts a run nothing can cancel.
        const unwatchAbort = whenAborted(request.signal, onAbort);

        // Ends the phase when the run itself finishes, ending the drain below.
        let settled = false;

        // Not awaited: it lives as long as this phase's channel, and the frames below are what the turn is waiting on.
        const handedBack = channel === undefined ? Promise.resolve([]) : steerInto(started, channel, () => settled, deps.logger);

        const finished = (async () => {
            const handle = await started;
            if (handle === undefined) {
                return undefined;
            }
            const result = await handle.wait().catch((error: unknown) => {
                sendError = error;
                return undefined;
            });
            settled = true;
            endPhase();
            return result;
        })();

        let errored = false;
        try {
            for await (const item of queue) {
                if (item === PHASE_END) {
                    break;
                }
                if (item.kind === "error") {
                    errored = true;
                }
                yield item;
            }
            // What the restorer still holds goes out before anything that ends the phase.
            for (const frame of restorer?.flush() ?? []) {
                yield frame;
            }
            // Only the run's own settle resolves `finished`; a stall or a cancel grace ends the drain without one, and
            // awaiting it there is the hang this phase is bounded against.
            const result = settled ? await finished : undefined;
            refusedReplacement(instructions, sawDelta, sendError, result);
            if (stalled) {
                errored = true;
                yield { kind: "error", message: CURSOR_STALLED, code: "provider-outage" };
            } else if (sendError !== undefined) {
                errored = true;
                yield await codedError(sendError, await cursorSdk());
            } else if (result?.status === "error") {
                errored = true;
                yield cursorRunErrorFrame(result.error);
            }
            yield* mapper.ending(settled && !errored);
        } finally {
            clearTimeout(stall);
            // One listener per phase; a plan turn runs two, so an unremoved one leaks into the next phase.
            unwatchAbort();
        }
        const captured = mapper.capture();
        const planText = captured.planText === undefined || shield === undefined ? captured.planText : shield.restore(captured.planText);
        return { errored: errored || captured.errored === true, planText, handedBack };
    }

    // One run of the turn, on `instructions`' path: Cursor's base replaced by the owner's prompt, or everything folded
    // onto it. `resume` is the agent to open; `relay` the turn's one consumer of its steering queue, shared by a retry.
    async function* attempt(
        request: AgentRequest<CursorCredential>,
        sdk: NonNullable<Awaited<ReturnType<typeof cursorSdk>>>,
        instructions: TurnInstructions,
        resume: string | undefined,
        relay: ReturnType<typeof steeringRelay> | undefined,
        extras: CursorTurnExtras,
    ): AsyncGenerator<AgentEvent> {
        // The SDK requires an explicit model with no default; the catalog is never empty, so this always resolves.
        const modelId = request.spec.model !== undefined && request.spec.model !== "" ? request.spec.model : (await deps.catalog.models()).default;
        const item = await deps.catalog.item(modelId);
        // Without the vendor record (persisted/seeded) the bare id is sent: an untranslatable effort isn't guessed.
        const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, request.spec.effort);

        // Attachments ride the prompt as a file list; Cursor's read tool takes them off disk, like the OpenCode/Pi
        // runtimes. A sealed request's system prompt rides in front of its words (turnWords): the SDK's own seam for it is
        // entitlement-gated, and the hook service a turn's instructions go through is a setting source a sealed request
        // does not load.
        const { images, others } = splitAttachments(request.spec.attachments ?? []);
        const anchor = request.spec.isolation?.anchor;
        const { commands, words, told } = await turnWords(request, instructions);

        // The turn's tool list (cursor-tool-list.ts), held only where the hooks that check it are in place; a sealed
        // request already offers no tool at all.
        const list = request.policy.sealed === true ? undefined : request.policy.allowedTools;
        if (list !== undefined && !(await listHeld(deps.hooks))) {
            yield { kind: "error", message: CURSOR_LIST_HOOKS_MISSING };
            yield { kind: "done" };
            return;
        }

        // The privacy shield, reading this turn channel by channel (cursor-shield.ts). A sealed request was read whole
        // by the shield before it got here (privacy-shield.ts `seal`), so only a turn carries one.
        const shield = request.policy.sealed === true ? undefined : request.hooks.privacy;
        let shielded: Exclude<Awaited<ReturnType<typeof shieldedStart>>, { readonly refused: unknown }> | undefined;
        if (shield !== undefined) {
            // The hooks are how the shield reads this runtime at all: without them it would read nothing past the prompt.
            // allow(silent-catch): hooks that cannot be read are hooks that do not cover the turn, which is refused just below with why.
            const covered = deps.hooks.ready() && (await deps.hooks.covers().catch(() => false));
            const refusal = covered
                ? await shieldedStart(shield, request, anchor, told)
                : { refused: { kind: "error" as const, code: "privacy-unshielded" as const, message: CURSOR_HOOKS_MISSING } };
            if ("refused" in refusal) {
                yield refusal.refused;
                yield { kind: "done" };
                return;
            }
            shielded = refusal;
        }
        const basePrompt = withFileNote(words, [...images, ...others]);
        const systemAppend = shield === undefined ? told.append : shielded?.append;
        const systemPrompt = shield === undefined ? told.replace : shielded?.replace;

        // One stream for the turn, two producers: the SDK's mapped deltas, and the custom tool handlers and hooks that
        // run inside Cursor's loop with no generator to yield from. They share it because a handler that parks on a
        // person is itself what stops the deltas, so a card waiting for the next one would never be shown — and the
        // handler holding the turn would never be answered.
        const queue = new EventQueue<PhaseItem>();
        const push = (event: AgentEvent): void => queue.push(event);

        // Rulebook axis "hooks" makes a hold park on a card, not refuse, while the hook process waits on the socket.
        // Built ahead of the options because the JS backend rides a custom tool and consults this gate from inside its
        // own handler, where no hook can reach it.
        const { gate, taint, release } = vendorTurnGate(request);
        // Ends with the attempt, so a card a hook or a tool still holds open is settled once the run is gone.
        const ended = new AbortController();
        // Whether the phase now running puts calls to a person (cursor-approvals.ts): a plan's read-only first phase
        // does not. Set by each send below.
        const phase = { asking: true };
        const owner = cursorOwner(request, push, AbortSignal.any([request.signal, ended.signal]), () => phase.asking);
        const secrets = request.tools.secrets;

        // While the shield reads the turn the daemon's own tools mask what they answer and every MCP server is reached
        // through the masking proxy; while it masks, the tools that read past it are withheld too. Watching changes
        // nothing Cursor can do: it only reads what passes. A tool list mounts only what it names; a stored secret's
        // value is masked out of what the daemon's own tools answer.
        const listed = listedCustomTools(cursorCustomTools(request, { gate, taint }, push, owner), list);
        const customTools = secrets === undefined ? listed : secretMaskedCustomTools(listed, secrets);
        const mcpServers = listedMcpServers(cursorMcpServers(request), list);
        // The worn persona's own skills, laid out where Cursor's loader reads them (cursor-skills.ts).
        const kit = request.policy.sealed === true ? { dirs: [], release: async () => {} } : await projectKit(extras.skills ?? NO_SKILLS, request.spec.isolation);
        const options = await turnOptions({ request, selection, systemPrompt, shield, shielded, list, customTools, mcpServers, dirs: kit.dirs, logger: deps.logger });

        // An anchored turn's agent runs in a runtime process born in its namespace, so the shell the SDK spawns and the
        // files it edits resolve /work to the worktree, as every other isolated runtime's do. The anchor's cwd is already
        // this request's cwd (stream-agent.ts), so the local store scopes the session the same way in either process.
        const host =
            anchor === undefined
                ? inProcessHost(sdk)
                : namespacedHost({
                      namespace: { pid: anchor.pid, cwd: anchor.cwd, ...opt("namespace", anchor.namespace) },
                      sdk,
                      sdkEntry: await cursorSdkEntry(),
                      spawnDepth: request.spec.spawnDepth ?? 0,
                      logger: deps.logger,
                      ...opt("owner", request.spec.conversationId),
                      ...deps.runtime,
                  });

        let agent: CursorSession | undefined;
        try {
            const opened = await host(resume, options);
            // While the shield reads the turn, everything sent to the agent goes through it: the prompt, a plan's
            // revision, the approval, steering and follow-ups alike.
            agent = shield === undefined ? opened : shieldedSession(opened, shield);
        } catch (error) {
            release();
            await kit.release();
            yield await codedError(error, sdk);
            yield { kind: "done" };
            return;
        }

        // Session id a follow-up resumes on, and the id the hook gate correlates a consult back to.
        yield { kind: "session", sessionId: agent.agentId };
        yield { kind: "init", model: modelId };
        if (commands.length > 0) {
            yield { kind: "commands", items: commands.map(({ name, description }) => ({ name, description })) };
        }

        // The session's shell gets the turn's credentials and the heavy table's environment, so its programs queue
        // and its installs take the install lane as a Claude Code turn's do.
        const shellEnv = { ...request.tools.cliEnv, ...(await vendorShellEnv(request.tools, { ...process.env, ...request.tools.cliEnv })) };
        const retire = deps.hooks.register(
            hookTurn({ agentId: agent.agentId, request, shellEnv, systemAppend, gate, push, shield, list, owner, skills: extras.skills }),
        );

        // The SDK's local store marks a run finished only from inside the process that ran it, so a daemon killed
        // mid-run (an OOM kill, a restart) leaves that run RUNNING on disk, and every later send on the agent throws
        // "already has active run" for good. Turns on one conversation are serialized, so any run still open when a
        // resumed agent's first send goes out is that orphan: `force` expires it, the SDK's own recovery for exactly
        // this. Later phases of the same turn follow a run this process settled itself, and are sent plainly.
        let orphanPossible = resume !== undefined;

        try {
            const live = agent;
            const send = async function* (prompt: string, planning: boolean): AsyncGenerator<AgentEvent, { errored: boolean; planText?: string }> {
                // Each phase borrows its own channel and closes it, so a message typed during a plan's approval pause
                // waits for the executing phase instead of being delivered to the run that already finished.
                const channel = relay?.();
                phase.asking = !planning;
                const force = orphanPossible;
                orphanPossible = false;
                try {
                    const outcome = yield* runPhase(live, request, queue, prompt, selection, planning, channel, force, shield, instructions);
                    // The run has settled, so this phase takes no more steering. Planning leaves what is still queued
                    // for the executing phase; the last phase closes the turn's queue, so a message sent after this is
                    // refused at the route rather than left in a relay nothing will read again.
                    if (planning) {
                        channel?.close();
                    } else {
                        request.spec.steering?.close();
                    }
                    const handedBack = await outcome.handedBack;
                    if (handedBack.length === 0 || outcome.errored || request.signal.aborted) {
                        if (handedBack.length > 0) {
                            deps.logger.warn(
                                { messages: handedBack.length },
                                "cursor: steering messages not taken by a run that failed or was stopped",
                            );
                        }
                        return { errored: outcome.errored, ...opt("planText", outcome.planText) };
                    }
                    // Sent on the same agent and in the same mode, so a plan still ends in a plan; it has no steering of
                    // its own, since admission already closed. The session masks it like any other message.
                    const followUp = yield* runPhase(live, request, queue, handedBack.join("\n\n"), selection, planning, undefined, false, shield, instructions);
                    return { errored: followUp.errored, ...opt("planText", followUp.planText ?? outcome.planText) };
                } finally {
                    channel?.close();
                }
            };

            yield* planMode(
                PLAN_EMULATED,
                request,
                () => ({
                    // The preamble rides the prompt though mode:"plan" enforces read-only: it tells the model to end with a
                    // plan.
                    prompt: `${PLAN_PREAMBLE}${basePrompt}`,
                    async *plan(prompt) {
                        const outcome = yield* send(prompt, true);
                        // Session never changes across phases; reporting undefined here keeps the emulation's seed rather
                        // than reassigning it.
                        return { sessionId: undefined, planText: outcome.planText, errored: outcome.errored };
                    },
                    execute: () => send(EXECUTE_PROMPT, false),
                }),
                () => send(basePrompt, false),
            );
        } catch (error) {
            if (error instanceof SystemPromptRefused) {
                error.agentId = agent.agentId;
            }
            throw error;
        } finally {
            // Order matters: retire, then release, then close; a consult between finds no turn, and is allowed. The
            // release also settles a card a hook or tool left open when the run ended without waiting for it.
            retire();
            release();
            ended.abort();
            agent.close();
            await kit.release();
        }
        yield { kind: "done" };
    }

    // Whether each account may replace Cursor's base prompt, learned from its first turn that tried: the entitlement is
    // the account's, server-side, and nothing answers it ahead of a send. Kept for the daemon's life, by hashed key.
    const entitled = new Map<string, boolean>();

    return async function* cursorAgent(request: AgentRequest<CursorCredential>, extras: CursorTurnExtras = {}): AsyncGenerator<AgentEvent> {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            yield { kind: "error", message: CURSOR_SDK_MISSING };
            yield { kind: "done" };
            return;
        }
        const apiKey = request.credential.apiKey;
        if (apiKey === "") {
            // Reached only when a request is built by hand; planCursorTurn already refuses first with the same code.
            yield { kind: "error", message: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.", code: "subscription-required" };
            yield { kind: "done" };
            return;
        }
        // This turn's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const relay = request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering);
        const account = accountOf(apiKey);
        const replacing = request.policy.sealed !== true && nonBlank(request.spec.systemPrompt) !== undefined && entitled.get(account) !== false;
        const instructions: TurnInstructions = { replacing, accepted: false };
        try {
            yield* attempt(request, sdk, instructions, request.spec.sessionId, relay, extras);
        } catch (error) {
            if (!(error instanceof SystemPromptRefused)) {
                throw error;
            }
            // Refused before Cursor said a word: the turn runs again on the append path, on the agent the refusal opened.
            entitled.set(account, false);
            deps.logger.info({ reason: error.message }, "cursor: this account may not replace Cursor's base prompt; its turns append to it instead");
            yield* attempt(request, sdk, { replacing: false, accepted: false }, error.agentId ?? request.spec.sessionId, relay, extras);
            return;
        }
        if (instructions.accepted) {
            entitled.set(account, true);
        }
    };
};
