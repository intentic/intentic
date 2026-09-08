import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, ToolName } from "@cursor/sdk";
import { whenAborted } from "../../abort.js";
import type { OneShotAsk } from "../../agent/providers/adapter.js";
import type { Services } from "../../composition.js";
import { usableCursorAccount } from "./cursor-credentials.js";
import { selectionFor } from "./cursor-models.js";
import { cursorReadiness } from "./cursor-readiness.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";

// Cursor's one-shot (agent/adapter.ts oneShot): one prompt in, one string out, on Cursor's own runtime, since Cursor
// has no translator route or subscription endpoint for the Claude Code one-shot path. Same move as cursor-agent.ts's
// chat turns, one layer down. No tools, no MCP, no session, and a deadline the chain can step over.

const DEADLINE_MS = 20_000;

// Empty allowlist, not a denylist: an unknown tool name in disallowedTools makes Agent.create reject outright.
const NO_TOOLS: readonly ToolName[] = [];

const textOf = (updates: readonly InteractionUpdate[]): string =>
    updates
        .flatMap((update) => (update.type === `text-delta` && update.text !== `` ? [update.text] : []))
        .join(``)
        .trim();

const helperError = (error: unknown, sdk: Awaited<ReturnType<typeof cursorSdk>>): Error => {
    const message = error instanceof Error && error.message !== `` ? error.message : `The Cursor helper did not answer.`;
    if (sdk === undefined) {
        return new Error(message);
    }
    if (error instanceof sdk.RateLimitError) {
        return new Error(message);
    }
    if (error instanceof sdk.AuthenticationError) {
        return new Error(`${message} Connect your Cursor account again in Sandbox ▸ Agent.`);
    }
    return new Error(message);
};

export const cursorOneShot = async (services: Pick<Services, "cursorStore" | "cursorModels">, ask: OneShotAsk): Promise<string> => {
    const readiness = await cursorReadiness(services.cursorStore);
    if (!readiness.ok) {
        throw new Error(readiness.detail);
    }
    const account = await usableCursorAccount(services.cursorStore, undefined);
    if (account === undefined) {
        throw new Error(`Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.`);
    }
    const sdk = await cursorSdk();
    if (sdk === undefined) {
        throw new Error(CURSOR_SDK_MISSING);
    }
    const catalog = await services.cursorModels.models();
    const modelId =
        ask.model !== undefined && ask.model !== `` && catalog.models.some((entry) => entry.id === ask.model)
            ? ask.model
            : catalog.default;
    // Effort maps onto whatever dial this model publishes, like a chat turn's; absent still means absent.
    const item = await services.cursorModels.item(modelId);
    const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, ask.effort);

    let expired = false;
    const abort = new AbortController();
    const forward = (): void => abort.abort();
    ask.signal.addEventListener(`abort`, forward, { once: true });
    const deadline = setTimeout(() => {
        expired = true;
        abort.abort();
    }, DEADLINE_MS);

    const updates: InteractionUpdate[] = [];
    let agent: SDKAgent | undefined;
    let run: Run | undefined;

    const options: AgentOptions = {
        model: selection,
        apiKey: account.apiKey,
        tools: [...NO_TOOLS],
        local: { cwd: ask.cwd, settingSources: [] },
    };

    try {
        agent = await sdk.Agent.create(options);
        const unwatch = whenAborted(abort.signal, () => {
            void run?.cancel().catch(() => undefined);
        });
        try {
            run = await agent.send(ask.prompt, {
                onDelta: ({ update }) => {
                    updates.push(update);
                },
            });
            const result = await run.wait();
            if (result.status === `error`) {
                throw new Error(result.error?.message ?? `The Cursor helper did not answer.`);
            }
        } catch (error) {
            if (ask.signal.aborted && !expired) {
                throw error;
            }
            throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : helperError(error, sdk);
        } finally {
            unwatch();
        }
        const text = textOf(updates);
        if (text === ``) {
            if (ask.signal.aborted && !expired) {
                throw new Error(`aborted`);
            }
            throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
        }
        return text;
    } finally {
        clearTimeout(deadline);
        ask.signal.removeEventListener(`abort`, forward);
        agent?.close();
    }
};
