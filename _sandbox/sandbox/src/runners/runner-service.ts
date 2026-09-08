import { mkdir, statfs, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, normalize } from "node:path";
import { narrate } from "@intentic/base/async";
import {
    type AgentEvent,
    AgentHarnessSchema,
    AgentProviderSchema,
    type AgentTurn,
    type RunnerFacts,
    type RunnerSync,
    type RunnerSyncLine,
    type RunnerTurn,
    runnerContract,
} from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { applyReply, applySteer, composeSteerText } from "../agent/run/turn/turn-interactions.js";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../portability/apply-definition.js";
import { parseDefinitionToml } from "../portability/definition.js";
import { pushToParent, type RunnerSyncDeps, syncFromParent } from "./runner-sync.js";
import type { RunnerIdentity } from "./runner-identity.js";

// The oRPC server on the socket this runner dialled out (the host router's inversion). Everything here is a thin
// adapter onto machinery this daemon already has: a turn is streamAgent, the same composition a local turn runs; a sync
// is stock git against the parent's door. A remote turn behaves like a local one because it is the same code.

// freeDiskMb is read where the workspace lives, which is the disk a turn actually fills.
const facts = async (workspaceRoot: string): Promise<RunnerFacts> => {
    const disk = await statfs(workspaceRoot).catch(() => undefined);
    return {
        cpus: cpus().length,
        memoryMb: Math.round(totalmem() / 1_048_576),
        freeDiskMb: disk === undefined ? 0 : Math.round((disk.bavail * disk.bsize) / 1_048_576),
        // Normalised to core count, so "1" means saturated on any machine size; answers "is it busy right now".
        load: cpus().length === 0 ? 0 : Math.round(((loadavg()[0] ?? 0) / cpus().length) * 100) / 100,
    };
};

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

export const createRunnerService = (services: Services, identity: RunnerIdentity) => {
    const deps: RunnerSyncDeps = {
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        worktrees: services.agentWorktrees,
    };
    // One live turn per conversation, for `interrupt` to abort; the link's own handle, no conversation lookup.
    const running = new Map<string, AbortController>();

    const materializeAttachments = async (input: RunnerTurn): Promise<void> => {
        for (const file of input.attachments ?? []) {
            const target = join(services.workspace.root, file.path);
            // A path resolving outside the workspace is an attempt, not an attachment; the whole turn is refused.
            if (!normalize(target).startsWith(services.workspace.root)) {
                throw new Error(`attachment path escapes the workspace: ${file.path}`);
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from(file.bytesBase64, "base64"));
        }
    };

    async function* runTurn(input: RunnerTurn): AsyncGenerator<AgentEvent> {
        const { turn, refusal } = turnOf(input);
        if (turn === undefined) {
            yield { kind: "error", message: refusal ?? "the dispatched turn could not be translated" };
            yield { kind: "done" };
            return;
        }
        await materializeAttachments(input);
        const controller = new AbortController();
        running.set(input.conversationId, controller);
        try {
            yield* streamAgent(services, turn, controller.signal);
        } finally {
            if (running.get(input.conversationId) === controller) {
                running.delete(input.conversationId);
            }
        }
    }

    const os = implement(runnerContract);
    return os.router({
        describe: os.describe.handler(async () => await facts(services.workspace.root)),
        ping: os.ping.handler(() => ({ ok: true })),
        syncWorkspace: os.syncWorkspace.handler(({ input }) =>
            narrated((onLine) =>
                input.op === "pull"
                    ? syncFromParent(deps, identity, input as RunnerSync, onLine)
                    : pushToParent(deps, identity, input as RunnerSync, onLine),
            ),
        ),
        runTurn: os.runTurn.handler(({ input }) => runTurn(input)),
        // Applied by the same function a local answer takes, so a question closes identically wherever it runs. A gated
        // credential's release cannot come this way (a known gap): the hop carries no verified identity, so it fails
        // closed.
        reply: os.reply.handler(async ({ input }) => ({ applied: (await applyReply(services, input)) === "settled" })),
        // Composed here deliberately: the attachment note names absolute paths meaningful only in this workspace.
        steer: os.steer.handler(({ input }) => {
            const composed = composeSteerText(services, input);
            if (composed.invalid !== undefined) {
                return { applied: false, invalid: composed.invalid };
            }
            return { applied: applySteer(input.conversationId, composed.text) };
        }),
        // The parent's settings push (a REPLACE); parsed by the same strict reader as any definition, so a bad field
        // fails named, not half-applied.
        applyDefinition: os.applyDefinition.handler(async ({ input }) => ({
            settings: await adoptDefinitionSettings(services, parseDefinitionToml(input.toml)),
        })),
        interrupt: os.interrupt.handler(({ input }) => {
            running.get(input.conversationId)?.abort();
            return { ok: true };
        }),
    });
};
