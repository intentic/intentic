import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, ToolName } from "@cursor/sdk";
import { whenAborted } from "../../abort.js";
import type { OneShotAsk } from "../../agent/providers/adapter.js";
import type { Services } from "../../composition.js";
import { usableCursorAccount } from "./cursor-credentials.js";
import { selectionFor } from "./cursor-models.js";
import { cursorReadiness } from "./cursor-readiness.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";

/* CURSOR'S ONE-SHOT (agent/adapter.ts oneShot): one prompt in, one string out, on Cursor's own runtime. It
 * exists for one reason: CURSOR HAS NO CLAUDE CODE ROAD AT ALL.
 *
 * There is no translator route to Cursor and Cursor publishes no subscription endpoint the harness could dial.
 * The one-shot helper walk used to fall through resolveHarnessCredentials into the Claude OAuth branch anyway,
 * then runOneShot with a Composer model id on the Claude Code loop, which fails every time and memoizes the
 * refusal for hours. Chat turns already run on @cursor/sdk (cursor-agent.ts); this is that same move one layer
 * down, for the commit subject and every other one-liner that walks the one-shot helper chain.
 *
 * The settings mirror the other runtimes' one-shots: no tools, no MCP, no custom tools, no session worth resuming, and a
 * deadline the chain can step over. A helper is a one-liner nobody is watching. */

const DEADLINE_MS = 20_000;

/* NO BUILT-IN TOOLS AT ALL, named as an EMPTY ALLOWLIST rather than a list of everything to switch off. A
 * commit subject is a rewrite of material already in the prompt; a tool call here is the model wandering off
 * rather than answering, so the toolset this run wants is the empty one.
 *
 * `tools: []` is the SDK's own spelling for that, and the denylist it replaces is why this rung was never
 * spent: Cursor derives its tool vocabulary from the agent proto at runtime and REJECTS `Agent.create` outright
 * on a name it does not know ("Unknown tool name(s) in `disallowedTools`: write"). The list here carried
 * `write`, which is not in that vocabulary (the file tool is `edit`), so every one-shot helper walk that reached
 * Composer threw before asking it, memoised the refusal for ten minutes, and paid a Claude rung instead — a
 * connected subscription with a full allowance skipped for a typo the type could not catch, since ToolName is
 * open (`string & {}`) for the proto names it cannot enumerate.
 *
 * An allowlist has no names to get wrong, so it cannot drift out of that vocabulary again, and it is closed
 * rather than exhaustive: a tool Cursor adds tomorrow is off by default instead of on until someone remembers
 * to deny it. */
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
    /* THE PIN'S EFFORT, mapped onto whatever dial this Cursor model publishes, exactly as a chat turn's is
     * (cursor-models.ts selectionFor). It used to be hardcoded `undefined` on the argument that a helper is a
     * one-liner with nothing to reason about — which is a good default and was standing in for a rule, so an
     * owner who pinned a tier to a role got a row that said "X-High" and a call that spent none of it. Absent
     * still means absent, and lands on the model's own default. */
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
