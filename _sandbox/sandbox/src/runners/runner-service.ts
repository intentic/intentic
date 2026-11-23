import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
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
import type { InferContractRouterInputs } from "@orpc/contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../definition/apply-definition.js";
import { parseDefinitionToml } from "../definition/definition.js";
import { gitEnv, pushToParent, type RunnerSyncDeps, syncFromParent } from "./runner-sync.js";
import { createRunnerCommands } from "./runner-command.js";
import { materializeFiles } from "./files/runner-files.js";
import { opt } from "../opt.js";
import { machineFacts } from "./machine-facts.js";
import type { RemoteTurns } from "./held-turns/remote-turns.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { keepRunnerPresentation } from "./naming/runner-presentation.js";
import { DISPATCHED_CHILD_NOTES } from "./held-turns/dispatched-child-notes.js";
import { filePresentationStore } from "../system/presentation/presentation-store.js";
import { runnerFeed } from "./live/runner-live-doors.js";
import { type RunnerCardStops, runnerLiveDeps } from "./live/runner-live-wiring.js";
import { type FileDoorDeps, listArtifactsDoor, readArtifactDoor, readPageDoor, readPageMediaDoor } from "./files/runner-file-doors.js";

type ContractInput<K extends keyof typeof runnerContract> = InferContractRouterInputs<typeof runnerContract>[K];

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
    // A path resolving outside the workspace is an attempt, not an attachment; the whole turn is refused.
    await materializeFiles(services.workspace.root, input.attachments);
    if (input.childNote !== undefined) {
        // Read as the turn is planned (child-preamble.ts): this runner has no record of the child to write it from.
        services.conversations.holdings(DISPATCHED_CHILD_NOTES).hold(input.conversationId, input.conversationId, input.childNote);
    }
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
export const syncHeld = (remoteTurns: Pick<RemoteTurns, "held" | "settle" | "delivered">, deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync): AsyncGenerator<RunnerSyncLine> => {
    if (input.op === "pull") {
        return remoteTurns.held(input.conversationId).state === "live" ? refusedPull() : narrated((onLine) => syncFromParent(deps, identity, input, onLine));
    }
    return narrated(async (onLine) => {
        await remoteTurns.settle(input.conversationId);
        // A turn still running here (the parent stopped following it, or its link dropped) is mid-write: its leftovers
        // wait for a push after it ends, which the parent's next dispatch makes as it collects the turn.
        const leftovers = remoteTurns.held(input.conversationId).state !== "live";
        await pushToParent(deps, identity, input, onLine, { leftovers });
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

// Applied by the same function a local answer takes, so a question closes identically wherever it runs. A gated
// credential's release cannot come this way (a known gap): the hop carries no verified identity, so it fails closed. The
// files an answer attaches are written first, at the paths it names (runner-files.ts).
export const replyHere = async (services: Services, input: ContractInput<"reply">): Promise<{ applied: boolean }> => {
    const { files, ...reply } = input;
    await materializeFiles(services.workspace.root, files);
    return { applied: (await services.turns.reply(reply)) === "settled" };
};

// Composed here deliberately: the attachment note names absolute paths meaningful only in this workspace. The files it
// names are written first; whose words they are is the parent's to say, the person's unless it says.
export const steerHere = async (services: Services, input: ContractInput<"steer">): Promise<{ applied: boolean; invalid?: string }> => {
    try {
        await materializeFiles(services.workspace.root, input.files);
    } catch (error) {
        return { applied: false, invalid: errorMessage(error) };
    }
    const steered = await services.turns.steer(input.conversationId, {
        text: input.text,
        voice: input.voice ?? "person",
        ...opt("outside", input.outside),
        ...opt("errand", input.errand),
        ...opt("attachments", input.attachments),
        ...opt("mentions", input.mentions),
        ...opt("editorContext", input.editorContext),
    });
    return typeof steered === "object" ? { applied: false, invalid: steered.invalid } : { applied: steered };
};

export const createRunnerService = (services: Services, identity: RunnerIdentity, stops?: RunnerCardStops) => {
    const { remoteTurns } = services;
    const deps: RunnerSyncDeps = {
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        worktrees: services.agentWorktrees,
        titleOf: (id) => {
            // The card's own title, which a sealed conversation does not show (conversations/seal/seal-family.ts sharedTitleOf).
            const entry = services.agents.entry(id);
            return entry === undefined || entry.seal !== undefined ? undefined : entry.social.title?.text;
        },
    };
    const files: FileDoorDeps = {
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        checkoutOf: (id) => services.agentWorktrees.conversationDir(id),
    };
    // Lines the parent offloaded here (settings `offload` on the parent), each in the offload tree of its repo.
    const commands = createRunnerCommands({
        offloadRoot: join(services.config.historyRoot, "offload"),
        gitUrl: (repo) => runnerGitUrl(identity.parentUrl, repo),
        gitEnv: gitEnv(identity),
        queue: services.queueHeavy,
    });

    // The file this machine's `ic sandbox list` reads the runner's name and its parent from (runner-presentation.ts).
    const presentation = filePresentationStore(services.config.historyRoot);

    const live = runnerLiveDeps(services, stops);

    const os = implement(runnerContract);
    return os.router({
        // Measured on every ask, by the same ruler the parent measures itself with, so its fleet advice compares like with like.
        describe: os.describe.handler(async () => await machineFacts(services.workspace.root, { budget: services.resources })),
        ping: os.ping.handler(() => ({ ok: true })),
        syncWorkspace: os.syncWorkspace.handler(({ input }) => syncHeld(remoteTurns, deps, identity, input as RunnerSync)),
        runTurn: os.runTurn.handler(({ input }) => runHeldTurn(services, input)),
        attachTurn: os.attachTurn.handler(({ input }) => followHeld(remoteTurns, input)),
        heldTurn: os.heldTurn.handler(({ input }) => remoteTurns.held(input.conversationId)),
        readPage: os.readPage.handler(({ input }) => readPageDoor(files, input)),
        readArtifact: os.readArtifact.handler(({ input }) => readArtifactDoor(files, input)),
        listArtifacts: os.listArtifacts.handler(({ input }) => listArtifactsDoor(files, input)),
        readPageMedia: os.readPageMedia.handler(({ input }) => readPageMediaDoor(files, input)),
        ackTurn: os.ackTurn.handler(({ input }) => {
            remoteTurns.ack(input.conversationId, input.after);
            return { ok: true };
        }),
        // Applied by the same function a local answer takes, so a question closes identically wherever it runs. A gated
        // credential's release cannot come this way (a known gap): the hop carries no verified identity, so it fails
        // closed.
        reply: os.reply.handler(({ input }) => replyHere(services, input)),
        steer: os.steer.handler(({ input }) => steerHere(services, input)),
        // The parent's settings push (a REPLACE); parsed by the same strict reader as any definition, so a bad field
        // fails named, not half-applied.
        applyDefinition: os.applyDefinition.handler(async ({ input }) => ({
            settings: await adoptDefinitionSettings(services, parseDefinitionToml(input.toml)),
        })),
        // What the parent calls this runner and itself, kept where its machine reads a sandbox's name.
        present: os.present.handler(async ({ input }) => {
            await keepRunnerPresentation(presentation, identity, input);
            return { ok: true };
        }),
        interrupt: os.interrupt.handler(({ input }) => {
            remoteTurns.interrupt(input.conversationId);
            return { ok: true };
        }),
        runCommand: os.runCommand.handler(({ input }) => commands.run(input)),
        cancelCommand: os.cancelCommand.handler(({ input }) => {
            commands.cancel(input.runId);
            return { ok: true };
        }),
        // A conversation's live views, for the parent's editor (live/runner-live-doors.ts).
        feed: os.feed.handler(({ signal }) => runnerFeed(live, signal)),
        browsers: os.browsers.handler(() => ({ sessions: live.browsers() })),
        openBrowser: os.openBrowser.handler(({ input }) => live.openBrowser(input.url)),
        closeBrowser: os.closeBrowser.handler(async ({ input }) => {
            await live.closeBrowser(input.name);
            return { ok: true };
        }),
        closeBrowserPage: os.closeBrowserPage.handler(async ({ input }) => {
            await live.closeBrowserPage(input.name, input.pageId);
            return { ok: true };
        }),
        desktop: os.desktop.handler(() => live.desktop()),
        browserTab: os.browserTab.handler(({ input }) => live.browserTab(input)),
        stopJob: os.stopJob.handler(async ({ input }) => ({ stopped: await live.stopJob(input.conversationId, input.jobId) })),
        stopWatching: os.stopWatching.handler(async ({ input }) => ({ stopped: await live.stopWatches(input.conversationId, input.watchId) })),
        vetPort: os.vetPort.handler(async ({ input }) => opt("refused", await live.vetPort(input.port))),
        revoke: os.revoke.handler(async ({ input }) => {
            await live.revoke(input.member);
            return { ok: true };
        }),
    });
};
