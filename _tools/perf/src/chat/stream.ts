// A turn streamed into a long conversation, standing in for an agent at work: the demo's own replies are a sentence
// and one call. Serialised into the page by Playwright, so it reaches nothing but its argument and the page's globals.

export interface StreamAsk {
    readonly conversationId: string;
    /** How long the turn streams, in ms of the page's own clock. */
    readonly ms: number;
}

/** What the streamed turn reports, as `window.perfChat` holds it. */
export interface StreamState {
    /** Transcript patches sent so far. */
    patches: number;
    /** The turn has ended. */
    done: boolean;
}

declare global {
    interface Window {
        perfChat?: StreamState;
    }
}

/**
 * Answers a send in `conversationId` the way the daemon does (`POST /agent`, then `POST /agent/attach` streaming the
 * run's rows), with a turn of its own: answers written a few words every 16ms with markdown in them, and calls that
 * start and finish between them, until `ms` has passed. Wraps the `fetch` the demo installs, as `inflateTranscript`
 * does (`_site/demo/src/transport.ts`); every other request passes through.
 */
export function streamTurn(ask: StreamAsk): void {
    const state: StreamState = { patches: 0, done: false };
    window.perfChat = state;
    const RUN = `run_perf_chat`;
    const prose = [
        `Reading the handler first, since the route and the job have to agree on what a deleted user is.`,
        ``,
        "- `liveUsers()` now filters on `deleted_at`, so every read path skips a retired row.",
        "- The purge job takes rows older than **30 days** and removes them for good.",
        ``,
        "```ts",
        `export const purge = (before: Date) => db.delete(users).where(lt(users.deletedAt, before));`,
        "```",
        ``,
        `Next I run the tests for the users module, then the migration against a copy of the schema.`,
    ].join(`\n`);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": `application/json` } });
    const bodyOf = async (input: RequestInfo | URL, init?: RequestInit): Promise<{ conversationId?: string; prompt?: string } | undefined> => {
        try {
            const text = input instanceof Request ? await input.clone().text() : typeof init?.body === `string` ? init.body : ``;
            return text === `` ? undefined : JSON.parse(text);
        } catch (error) {
            // A body that is not JSON is not this conversation's ask, and goes on to the demo's own fetch; any other
            // failure is the harness's own and is worth seeing.
            if (error instanceof SyntaxError) {
                return undefined;
            }
            throw error;
        }
    };
    const run = (prompt: string): Response => {
        const encoder = new TextEncoder();
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                const send = (value: unknown): void => {
                    if (!cancelled) {
                        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`));
                    }
                };
                const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
                let seq = 0;
                const patch = (value: unknown): void => {
                    seq += 1;
                    state.patches += 1;
                    send({ kind: `patch`, seq, patch: value });
                };
                const startedAt = Date.now();
                send({ kind: `attached`, run: RUN, startedAt, seq, rows: [{ role: `user`, text: prompt, sentAt: startedAt, run: RUN }] });
                const deadline = performance.now() + ask.ms;
                const live = (): boolean => !cancelled && performance.now() < deadline;
                // Row 0 is the prompt; each answer is a row of its own below it.
                for (let index = 1; live(); index += 1) {
                    patch({ op: `append`, row: { role: `assistant`, text: ``, run: RUN } });
                    for (let at = 0; at < prose.length && performance.now() < deadline; at += 24) {
                        patch({ op: `text`, index, text: prose.slice(at, at + 24) });
                        await wait(16);
                    }
                    for (const [call, name] of [
                        [`read`, `Read`],
                        [`run`, `Bash`],
                    ] as const) {
                        const id = `perf_${index}_${call}`;
                        const tool = { id, name, category: call === `read` ? `read` : `execute`, target: `api/src/users.ts` };
                        patch({ op: `tool`, index, tool: { ...tool, status: `in_progress` } });
                        await wait(50);
                        patch({ op: `tool`, index, tool: { ...tool, status: `completed`, content: [{ type: `text`, text: `ok\n`.repeat(40) }] } });
                        await wait(30);
                    }
                }
                state.done = true;
                send({ kind: `end` });
                if (!cancelled) {
                    controller.enqueue(encoder.encode(`event: done\n\n`));
                    controller.close();
                }
            },
            cancel: () => {
                cancelled = true;
            },
        });
        return new Response(body, { status: 200, headers: { "content-type": `text/event-stream` } });
    };
    let prompt: string | undefined;
    const wrap = (answer: typeof fetch): typeof fetch => {
        const streaming = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);
            const method = (input instanceof Request ? input.method : init?.method) ?? `GET`;
            if (method === `POST` && url.endsWith(`demo.invalid/agent`)) {
                const body = await bodyOf(input, init);
                if (body?.conversationId === ask.conversationId) {
                    prompt = body.prompt ?? ``;
                    return json({ delivered: `started`, run: RUN });
                }
            }
            if (method === `POST` && url.includes(`demo.invalid/agent/attach`) && prompt !== undefined) {
                const body = await bodyOf(input, init);
                if (body?.conversationId === ask.conversationId) {
                    return run(prompt);
                }
            }
            return answer(input, init);
        };
        return Object.assign(streaming, { preconnect: () => undefined });
    };
    // Over the demo's own fetch as it is installed, as `inflateTranscript` hooks it (mobile/page-scripts.ts, which says
    // why at the assignment and how two such hooks chain).
    const before = Object.getOwnPropertyDescriptor(globalThis, `fetch`);
    let current = globalThis.fetch;
    let wrapped = false;
    Object.defineProperty(globalThis, `fetch`, {
        configurable: true,
        enumerable: before?.enumerable ?? true,
        get: () => before?.get?.call(globalThis) ?? current,
        set: (next: typeof fetch) => {
            const taken = wrapped ? next : wrap(next);
            wrapped = true;
            if (before?.set === undefined) {
                current = taken;
            } else {
                before.set.call(globalThis, taken);
            }
        },
    });
}
