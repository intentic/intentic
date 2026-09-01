import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { runGeminiOneShot } from "./one-shot-gemini.js";

/* THE HELPER'S OTHER ROAD TO A MODEL: OpenCode, because the Claude Code loop cannot reach Google (the file says
 * why). What is worth pinning here is the shape of the session it opens, since both properties are invisible
 * from the answer and both cost real money when they regress. */

const created = vi.fn<(input: unknown) => Promise<{ data?: { id: string } }>>();
const prompt = vi.fn<(input: unknown) => Promise<{ data?: { parts: { type: string; text?: string }[] } }>>();
const removed = vi.fn<(input: unknown) => Promise<unknown>>();

const services = (): Services =>
    unstubbed<Services>(`services`, {
        openCode: unstubbed<Services[`openCode`]>(`openCode`, {
            client: async () =>
                ({
                    session: { create: created, prompt, delete: removed },
                }) as unknown as Awaited<ReturnType<Services[`openCode`][`client`]>>,
        }),
    });

const ask = (): Promise<string> =>
    runGeminiOneShot({
        services: services(),
        prompt: `Name this session`,
        cwd: `/work`,
        model: `gemini-3-flash`,
        signal: new AbortController().signal,
    });

const answering = (parts: { type: string; text?: string }[]): void => {
    created.mockResolvedValue({ data: { id: `ses_1` } });
    prompt.mockResolvedValue({ data: { parts } });
    removed.mockResolvedValue(undefined);
};

/* A SESSION CREATED WITHOUT A TITLE IS A SECOND MODEL CALL. OpenCode auto-titles one as soon as its first message
 * lands: its own "You are a title generator…" prompt, on the same provider, carrying our whole prompt as the
 * material, answered into a field nothing reads and then deleted with the session. Measured against a recording
 * upstream: two upstream requests per helper call unnamed, one when the session is created with a title. Every
 * landing, every session title and every held command paid double on this road. */
test("names the session it opens, so OpenCode never spends a call titling it", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);

    await expect(ask()).resolves.toBe(`Sandbox freezes · fix`);

    expect(created).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ title: expect.any(String) }) }));
});

// Tools are off for the same reason they are off on the Claude road: a one-liner is a rewrite of material already
// in the prompt. Pinned because the wildcard is what keeps this file from having to track OpenCode's tool names.
test("asks with every tool switched off", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);

    await ask();

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ tools: { "*": false } }) }));
});

/* A REPLY WITH NO TEXT IN IT IS NOT AN ANSWER, and the parts that are not text are dropped rather than
 * stringified: a tool call or a reasoning block reaching a caller as its commit subject is the failure the whole
 * answer contract exists for (quick-answer.ts), and this is the road it arrived by. */
test("a reply carrying no text is a rung that did not answer", async () => {
    answering([{ type: `tool` }, { type: `step-finish` }]);

    await expect(ask()).rejects.toThrow(/did not answer/);
});

// The session is deleted on both roads out, answered or not: without it every helper call would file a one-turn
// session in OpenCode's own store, which is the history pollution one-shot.ts records paying for once already.
test("leaves no session behind, whichever way the call ends", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);
    await ask();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });

    removed.mockClear();
    answering([]);
    await expect(ask()).rejects.toThrow();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });
});
