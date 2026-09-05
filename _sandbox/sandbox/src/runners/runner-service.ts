import { mkdir, statfs, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, normalize } from "node:path";
import { errorMessage } from "@intentic/base/errors";
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
import { streamAgent } from "../agent/agent.routes.js";
import { applyReply, applySteer, composeSteerText } from "../agent/turn-interactions.js";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../portability/apply-definition.js";
import { parseDefinitionToml } from "../portability/definition.js";
import { pushToParent, type RunnerSyncDeps, syncFromParent } from "./runner-sync.js";
import type { RunnerIdentity } from "./runner-identity.js";

/* WHAT THIS RUNNER ANSWERS, the oRPC server on the socket it dialled out (the host router's inversion,
 * _devices/machine/src/device/router.ts). Everything of substance is a thin adapter onto machinery this daemon
 * already has: a turn is streamAgent, the same composition every local turn runs through, and a sync is
 * stock git against the parent's door (runner-sync.ts). That reuse IS the design: a remote turn behaves
 * like a local one because it is the same code, only dispatched from elsewhere. */

// freeDiskMb is read where the workspace lives, which is the disk a turn actually fills.
const facts = async (workspaceRoot: string): Promise<RunnerFacts> => {
    const disk = await statfs(workspaceRoot).catch(() => undefined);
    return {
        cpus: cpus().length,
        memoryMb: Math.round(totalmem() / 1_048_576),
        freeDiskMb: disk === undefined ? 0 : Math.round((disk.bavail * disk.bsize) / 1_048_576),
        // Normalized to the core count, so "1" reads as saturated on every machine size; the one-minute
        // window answers the picker's actual question, "is it busy right now".
        load: cpus().length === 0 ? 0 : Math.round(((loadavg()[0] ?? 0) / cpus().length) * 100) / 100,
    };
};

// The host router's streamFlow, retold for a sync: run the operation, yield its lines as they are produced,
// end with one terminal frame carrying the outcome. Queued rather than dropped when the socket drains slower
// than git prints.
async function* narrated(run: (onLine: (line: string) => void) => Promise<void>): AsyncGenerator<RunnerSyncLine> {
    const queued: string[] = [];
    let wake: (() => void) | undefined;
    const nudge = (): void => {
        const pending = wake;
        wake = undefined;
        pending?.();
    };
    let settled: { readonly ok: boolean; readonly detail?: string } | undefined;
    const finished = run((line) => {
        queued.push(line);
        nudge();
    })
        .then(() => ({ ok: true }))
        .catch((error: unknown) => ({ ok: false, detail: errorMessage(error) }))
        .then((outcome) => {
            settled = outcome;
            nudge();
        });
    for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
            yield { kind: "line", text: next };
            continue;
        }
        if (settled !== undefined) {
            break;
        }
        await new Promise<void>((resolve) => {
            wake = resolve;
        });
    }
    await finished;
    yield settled?.ok === true
        ? { kind: "done", ok: true }
        : { kind: "done", ok: false, ...(settled?.detail !== undefined ? { detail: settled.detail } : {}) };
}

/* The dispatched turn as this daemon's own AgentTurn. Two refusals guard the translation: a provider or
 * harness this build does not know is answered as a readable error frame rather than a zod throw the parent
 * relays as a broken link, and an attachment path that escapes the workspace is refused outright. */
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
            // The parent lands; this mirror's main tree is never the review surface, so work stays on the
            // branch here regardless of the runner's own settings.
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
    // One live turn per conversation, the abort `interrupt` reaches for. streamAgent registers its own turn
    // control too; this map is the link's handle on it without a detour through conversation lookups.
    const running = new Map<string, AbortController>();

    const materializeAttachments = async (input: RunnerTurn): Promise<void> => {
        for (const file of input.attachments ?? []) {
            const target = join(services.workspace.root, file.path);
            // The prompt names the workspace-relative path; a path that resolves outside the workspace is not
            // an attachment but an attempt, and the whole turn is better refused than partially written.
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
        /* The user's answer, arriving from the parent (where the browser is) for a card THIS daemon raised.
         * Applied by the same function a local answer takes, dismissal-ends-the-turn included, so a question
         * closes identically wherever the turn happens to be running.
         *
         * A GATED CREDENTIAL'S RELEASE CANNOT COME THIS WAY, and that is a known gap rather than an oversight
         * (README's honesty list). The relay carries the ANSWER and not the answerer: the identity was
         * verified by the parent daemon against the parent's own roster, and this hop presents the runner
         * enrollment's token, so there is nothing here this side could check a named approver against.
         * `mayAnswer` therefore sees no caller and refuses, which is the fail-closed direction: a release card
         * raised by a remote turn goes unanswered rather than being released by an unverified click. Closing
         * it properly means carrying a signed statement of the verified identity across the hop. */
        reply: os.reply.handler(async ({ input }) => ({ applied: (await applyReply(services, input)) === "settled" })),
        // Composed HERE on purpose: the attachment note names absolute paths, and the only workspace those
        // paths mean anything in is this one (turn-interactions.ts).
        steer: os.steer.handler(({ input }) => {
            const composed = composeSteerText(services, input);
            if (composed.invalid !== undefined) {
                return { applied: false, invalid: composed.invalid };
            }
            return { applied: applySteer(input.conversationId, composed.text) };
        }),
        /* The parent pushing its settings onto this runner (the contract says why this is a REPLACE): parsed
         * by the same strict reader every definition takes, so a malformed push fails with the field named
         * instead of half-applying, and adopted through the settings store so the next turn reads it. */
        applyDefinition: os.applyDefinition.handler(async ({ input }) => ({
            settings: await adoptDefinitionSettings(services, parseDefinitionToml(input.toml)),
        })),
        interrupt: os.interrupt.handler(({ input }) => {
            running.get(input.conversationId)?.abort();
            return { ok: true };
        }),
    });
};
