import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { geminiOneShot } from "./gemini-one-shot.js";

// Pins the shape of the OpenCode session this helper opens (the road to Google), since both properties are invisible
// from the answer and cost money if they regress.

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
    geminiOneShot(services(), {
        provider: `gemini`,
        prompt: `Name this session`,
        cwd: WORKSPACE_ROOT,
        model: `gemini-3-flash`,
        signal: new AbortController().signal,
    });

const answering = (parts: { type: string; text?: string }[]): void => {
    created.mockResolvedValue({ data: { id: `ses_1` } });
    prompt.mockResolvedValue({ data: { parts } });
    removed.mockResolvedValue(undefined);
};

test("names the session it opens, so OpenCode never spends a call titling it", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);

    await expect(ask()).resolves.toBe(`Sandbox freezes · fix`);

    expect(created).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ title: expect.any(String) }) }));
});

// Wildcard `{"*": false}` avoids tracking OpenCode's individual tool names here.
test("asks with every tool switched off", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);

    await ask();

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ tools: { "*": false } }) }));
});

// Non-text parts (tool calls, reasoning) are dropped rather than stringified into the answer.
test("a reply carrying no text is a rung that did not answer", async () => {
    answering([{ type: `tool` }, { type: `step-finish` }]);

    await expect(ask()).rejects.toThrow(/did not answer/);
});

test("leaves no session behind, whichever way the call ends", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);
    await ask();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });

    removed.mockClear();
    answering([]);
    await expect(ask()).rejects.toThrow();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });
});
