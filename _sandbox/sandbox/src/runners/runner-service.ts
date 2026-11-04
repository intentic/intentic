import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { narrate } from "@intentic/base/async";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { AgentHarnessSchema, AgentProviderSchema, type AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import {
    type RunnerAttach,
    type RunnerSync,
    type RunnerSyncLine,
    type RunnerTurn,
    runnerGitUrl,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { runnerContract } from "@intentic/sandbox-contract/contracts/runner.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../definition/apply-definition.js";
import { parseDefinitionToml } from "../definition/definition.js";
import { gitEnv, pushToParent, type RunnerSyncDeps, syncFromParent } from "./runner-sync.js";
import { createRunnerCommands } from "./runner-command.js";
import { machineFacts } from "./machine-facts.js";
import type { RemoteTurns } from "./held-turns/remote-turns.js";
import type { RunnerIdentity } from "./runner-identity.js";

// The oRPC server on the socket this runner dialled out (the host router's inversion). Everything here is a thin
// adapter onto machinery this daemon already has: a turn, its answers and its steers go through the TurnStarter port,
// the same doors a local turn takes; a sync is stock git against the parent's door. A remote turn behaves like a local
// one because it is the same code.

// Turns a sync's callback lines into a stream via the shared `narrate` pump; only this wire's terminal `done` frame
// lives here.
const narrated = (run: (onLine: (line: string) => void) => Promise<void>): AsyncGenerator<RunnerSyncLine> =>
    narrate(run, (outcome): RunnerSyncLine => (outcome.ok ? { kind: "done", ok: true } : { kind: "done", ok: false, detail: outcome.error }));

// Translates a dispatched turn into this daemon's AgentTurn; an unknown provider/harness or an escaping attachment path
// is refused, not thrown.
const turnOf = (input: RunnerTurn): { turn?: AgentTurn; refusal?: string } => {
    const provider = AgentProviderSchema.safeParse(input.provider);
    const harness = AgentHarnessSchema.safeParse(input.harness);
    if (!provider.success || !harness.success) {
        return {
            refusal: `this runner's build does not know the ${provider.success ? "harness" : "provider"} "${provider.success ? input.harness : input.provider}" — update the runner.`,
        };
    }
    return {
        turn: {
            conversationId: input.conversationId,
            isolated: true,
            prompt: input.prompt,
            agent: provider.data,
            harness: harness.data,
            // The parent lands, never this mirror; work stays on the branch regardless of the runner's own settings.
            autoLand: false,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            ...(input.attachments !== undefined && input.attachments.length > 0 ? { attachments: input.attachments.map((file) => file.path) } : {}),
        },
    };
};

// What a dispatch for a conversation that still has a turn running here answers, without touching that turn.
async function* stillRunning(): AsyncGenerator<AgentEvent> {
    yield {
        kind: "error",
        code: "agent-busy",
        message: "This conversation's previous turn is still running on the runner. Wait for it to finish, or stop it.",
        own: true,
    };
    yield { kind: "done" };
}

async function* refusedPull(): AsyncGenerator<RunnerSyncLine> {
    yield { kind: "done", ok: false, code: "busy", detail: "this conversation's previous turn is still running on the runner, so its checkout was left alone" };
}

// A path resolving outside the workspace is an attempt, not an attachment; the whole turn is refused.
const materializeAttachments = async (workspaceRoot: string, input: RunnerTurn): Promise<void> => {
    for (const file of input.attachments ?? []) {
        const target = join(workspaceRoot, file.path);
        if (!normalize(target).startsWith(workspaceRoot)) {
            throw new Error(`attachment path escapes the workspace: ${file.path}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.bytesBase64, "base64"));
    }
};

// The turn runs held (remote-turns.ts), not pulled through this socket: it carries on to its end if the parent goes,
// and the parent reads on with `attachTurn` once it is back. This stream is only its first follower.
async function* runHeldTurn(services: Services, input: RunnerTurn): AsyncGenerator<AgentEvent> {
    const { turn, refusal } = turnOf(input);
    if (turn === undefined) {
        yield { kind: "error", message: refusal ?? "the dispatched turn could not be translated" };
        yield { kind: "done" };
        return;
    }
    if (services.remoteTurns.held(input.conversationId).state === "live") {
        yield* stillRunning();
        return;
    }
    await materializeAttachments(services.workspace.root, input);
    const followed = services.remoteTurns.start(input.conversationId, async function* (signal) {
        // The parent's own `begin` already judged who sent it; this mirror reopens for whatever the parent dispatched.
        await services.agents.clearArchived([input.conversationId]);
        yield* services.turns.stream(turn, signal);
    });
    if (followed === undefined) {
        yield* stillRunning();
        return;
    }
    yield* followed;
}

// A pull resets the conversation's checkout, so it waits for the turn still working in it; the parent collects that turn
// first (runner-dispatch.ts), and anything else it never received is kept before the reset (runner-sync.ts). A push
// waits for a turn that said `done` to finish unwinding, and once delivered the turn is let go.
const syncHeld = (remoteTurns: RemoteTurns, deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync): AsyncGenerator<RunnerSyncLine> => {
    if (input.op === "pull") {
        return remoteTurns.held(input.conversationId).state === "live" ? refusedPull() : narrated((onLine) => syncFromParent(deps, identity, input, onLine));
    }
    return narrated(async (onLine) => {
        await remoteTurns.settle(input.conversationId);
        await pushToParent(deps, identity, input, onLine);
        remoteTurns.delivered(input.conversationId);
    });
};

const followHeld = (remoteTurns: RemoteTurns, input: RunnerAttach): AsyncGenerator<AgentEvent> => {
    const followed = remoteTurns.follow(input.conversationId, input.after);
    if (followed === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `this runner holds no turn for ${input.conversationId}: it restarted since, or never ran one` });
    }
    return followed;
};

export const createRunnerService = (services: Services, identity: RunnerIdentity) => {
    const { remoteTurns } = services;
    const deps: RunnerSyncDeps = {
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        worktrees: services.agentWorktrees,
    };
    // Lines the parent offloaded here (settings `offload` on the parent), each in the offload tree of its repo.
    const commands = createRunnerCommands({
        offloadRoot: join(services.config.historyRoot, "offload"),
        gitUrl: (repo) => runnerGitUrl(identity.parentUrl, repo),
        gitEnv: gitEnv(identity),
        queue: services.queueHeavy,
    });

    const os = implement(runnerContract);
    return os.router({
        // Measured on every ask, by the same ruler the parent measures itself with, so its fleet advice compares like with like.
        describe: os.describe.handler(async () => await machineFacts(services.workspace.root, { budget: services.resources })),
        ping: os.ping.handler(() => ({ ok: true })),
        syncWorkspace: os.syncWorkspace.handler(({ input }) => syncHeld(remoteTurns, deps, identity, input as RunnerSync)),
        runTurn: os.runTurn.handler(({ input }) => runHeldTurn(services, input)),
        attachTurn: os.attachTurn.handler(({ input }) => followHeld(remoteTurns, input)),
        heldTurn: os.heldTurn.handler(({ input }) => remoteTurns.held(input.conversationId)),
        ackTurn: os.ackTurn.handler(({ input }) => {
            remoteTurns.ack(input.conversationId, input.after);
            return { ok: true };
        }),
        // Applied by the same function a local answer takes, so a question closes identically wherever it runs. A gated
        // credential's release cannot come this way (a known gap): the hop carries no verified identity, so it fails
        // closed.
        reply: os.reply.handler(async ({ input }) => ({ applied: (await services.turns.reply(input)) === "settled" })),
        // Composed here deliberately: the attachment note names absolute paths meaningful only in this workspace.
        steer: os.steer.handler(async ({ input }) => {
            const steered = await services.turns.steer(input.conversationId, {
                text: input.text,
                voice: "person",
                ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
                ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
                ...(input.editorContext === undefined ? {} : { editorContext: input.editorContext }),
            });
            return typeof steered === "object" ? { applied: false, invalid: steered.invalid } : { applied: steered };
        }),
        // The parent's settings push (a REPLACE); parsed by the same strict reader as any definition, so a bad field
        // fails named, not half-applied.
        applyDefinition: os.applyDefinition.handler(async ({ input }) => ({
            settings: await adoptDefinitionSettings(services, parseDefinitionToml(input.toml)),
        })),
        interrupt: os.interrupt.handler(({ input }) => {
            remoteTurns.interrupt(input.conversationId);
            return { ok: true };
        }),
        runCommand: os.runCommand.handler(({ input }) => commands.run(input)),
        cancelCommand: os.cancelCommand.handler(({ input }) => {
            commands.cancel(input.runId);
            return { ok: true };
        }),
    });
};
