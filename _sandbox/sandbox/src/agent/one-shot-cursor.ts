import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, ToolName } from "@cursor/sdk";
import { whenAborted } from "../abort.js";
import { usableCursorAccount } from "../cursor/cursor-credentials.js";
import { selectionFor } from "../cursor/cursor-models.js";
import { cursorReadiness } from "../cursor/cursor-readiness.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "../cursor/cursor-sdk.js";
import type { Services } from "../composition.js";

/* ONE PROMPT IN, ONE STRING OUT. ON CURSOR'S OWN RUNTIME. The same shape one-shot.ts and one-shot-gemini.ts
 * serve, and it exists for one reason: CURSOR HAS NO CLAUDE CODE ROAD AT ALL.
 *
 * There is no translator route to Cursor and Cursor publishes no subscription endpoint the harness could dial.
 * The quick model walk used to fall through resolveHarnessCredentials into the Claude OAuth branch anyway,
 * then runOneShot with a Composer model id on the Claude Code loop, which fails every time and memoizes the
 * refusal for hours. Chat turns already run on @cursor/sdk (cursor-agent.ts); this is that same move one layer
 * down, for the commit subject and every other one-liner that walks the quick model chain.
 *
 * The settings mirror the other one-shots: no tools, no MCP, no custom tools, no session worth resuming, and a
 * deadline the chain can step over. A helper is a one-liner nobody is watching. */

const DEADLINE_MS = 20_000;

/* Every built-in the SDK exposes, switched off. A commit subject is a rewrite of material already in the
 * prompt; a tool call here is the model wandering off rather than answering. */
const NO_TOOLS: readonly ToolName[] = [
    "askQuestion",
    "shell",
    "read",
    "edit",
    "write",
    "delete",
    "ls",
    "glob",
    "grep",
    "semSearch",
    "readLints",
    "createPlan",
    "generateImage",
    "recordScreen",
    "task",
    "updateTodos",
];

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

export const runCursorOneShot = async (params: {
    readonly services: Services;
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string;
    readonly signal: AbortSignal;
}): Promise<string> => {
    const readiness = await cursorReadiness(params.services.cursorStore);
    if (!readiness.ok) {
        throw new Error(readiness.detail);
    }
    const account = await usableCursorAccount(params.services.cursorStore, undefined);
    if (account === undefined) {
        throw new Error(`Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.`);
    }
    const sdk = await cursorSdk();
    if (sdk === undefined) {
        throw new Error(CURSOR_SDK_MISSING);
    }
    const catalog = await params.services.cursorModels.models();
    const modelId =
        params.model !== undefined && params.model !== `` && catalog.models.some((entry) => entry.id === params.model)
            ? params.model
            : catalog.default;
    const item = await params.services.cursorModels.item(modelId);
    const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, undefined);

    let expired = false;
    const abort = new AbortController();
    const forward = (): void => abort.abort();
    params.signal.addEventListener(`abort`, forward, { once: true });
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
        disallowedTools: [...NO_TOOLS],
        local: { cwd: params.cwd, settingSources: [] },
    };

    try {
        agent = await sdk.Agent.create(options);
        const unwatch = whenAborted(abort.signal, () => {
            void run?.cancel().catch(() => undefined);
        });
        try {
            run = await agent.send(params.prompt, {
                onDelta: ({ update }) => updates.push(update),
            });
            const result = await run.wait();
            if (result.status === `error`) {
                throw new Error(result.error?.message ?? `The Cursor helper did not answer.`);
            }
        } catch (error) {
            if (params.signal.aborted && !expired) {
                throw error;
            }
            throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : helperError(error, sdk);
        } finally {
            unwatch();
        }
        const text = textOf(updates);
        if (text === ``) {
            if (params.signal.aborted && !expired) {
                throw new Error(`aborted`);
            }
            throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
        }
        return text;
    } finally {
        clearTimeout(deadline);
        params.signal.removeEventListener(`abort`, forward);
        agent?.close();
    }
};
