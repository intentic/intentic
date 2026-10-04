import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { geminiOneShot } from "./gemini-one-shot.js";
import { privacySliceFake } from "../../privacy/privacy-slice.testing.js";

// Pins the shape of the OpenCode helper session and its runtime lifetime; none of these is visible from the answer.
const created = jest.fn<(input: unknown) => Promise<{ data?: { id: string } }>>();
const prompt = jest.fn<(input: unknown) => Promise<{ data?: { parts: { type: string; text?: string }[] } }>>();
const removed = jest.fn<(input: unknown) => Promise<void>>();
const aborted = jest.fn<(input: unknown) => Promise<void>>();
const acquired = jest.fn<(model: Parameters<Services["openCode"]["acquire"]>[0]) => void>();
const released = jest.fn<() => void>();

const services = (): Services =>
    unstubbed<Services>(`services`, {
        privacyShield: privacySliceFake().privacyShield,
        openCode: unstubbed<Services[`openCode`]>(`openCode`, {
            shielded: async () => true,
            acquire: async (model) => {
                acquired(model);
                return {
                    // SAFETY: the helper only calls these four session methods; their responses contain the fields
                    // it reads, and no other SDK operation is exercised by this fake.
                    client: { session: { create: created, prompt, delete: removed, abort: aborted } } as unknown as Awaited<
                        ReturnType<Services["openCode"]["client"]>
                    >,
                    release: released,
                };
            },
        }),
    });

const ask = (signal = new AbortController().signal, model = `gemini-3-flash`): Promise<string> =>
    geminiOneShot(services(), {
        provider: `gemini`,
        prompt: `Name this session`,
        cwd: WORKSPACE_ROOT,
        model,
        signal,
    });

const answering = (parts: { type: string; text?: string }[]): void => {
    created.mockResolvedValue({ data: { id: `ses_1` } });
    prompt.mockResolvedValue({ data: { parts } });
    removed.mockResolvedValue(undefined);
    aborted.mockResolvedValue(undefined);
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

test("names the session it opens, so OpenCode never spends a call titling it", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);
    await expect(ask()).resolves.toBe(`Sandbox freezes · fix`);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ title: expect.any(String) }) }));
    expect(released).toHaveBeenCalledTimes(1);
});

test("acquires the requested Google model, including a newly discovered Opus, without substituting another", async () => {
    answering([{ type: `text`, text: `A title` }]);
    await ask(undefined, "claude-opus-5-5-high");
    const model = { providerID: "intentic-gemini", modelID: "claude-opus-5-5-high" };
    expect(acquired).toHaveBeenCalledWith(model);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ model }) }));
    expect(released).toHaveBeenCalledTimes(1);
});

// Wildcard {"*": false} avoids tracking OpenCode's individual tool names here.
test("asks with every tool switched off", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);
    await ask();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ tools: { "*": false } }) }));
});

test("a reply carrying no text is a rung that did not answer", async () => {
    answering([{ type: `tool` }, { type: `step-finish` }]);
    await expect(ask()).rejects.toThrow(/did not answer/);
    expect(released).toHaveBeenCalledTimes(1);
});

test("leaves no session behind, whichever way the call ends", async () => {
    answering([{ type: `text`, text: `Sandbox freezes · fix` }]);
    await ask();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });
    removed.mockClear();
    answering([]);
    await expect(ask()).rejects.toThrow();
    expect(removed).toHaveBeenCalledWith({ path: { id: `ses_1` } });
    expect(released).toHaveBeenCalledTimes(2);
});

test.each(["rejected", "missing id"])("releases the runtime when session creation fails: %s", async (failure) => {
    answering([]);
    if (failure === "rejected") {
        created.mockRejectedValueOnce(new Error("cannot open session"));
    } else {
        created.mockResolvedValueOnce({});
    }
    await expect(ask()).rejects.toThrow();
    expect(prompt).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
});

test("releases the runtime when the prompt and session deletion both reject", async () => {
    answering([]);
    prompt.mockRejectedValueOnce(new Error("upstream unavailable"));
    removed.mockRejectedValueOnce(new Error("session gone"));
    await expect(ask()).rejects.toThrow("upstream unavailable");
    expect(removed).toHaveBeenCalledWith({ path: { id: "ses_1" } });
    expect(released).toHaveBeenCalledTimes(1);
});

test("keeps its lease through session deletion, not just through the model's answer", async () => {
    answering([{ type: "text", text: "A title" }]);
    const deleting = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    removed.mockImplementationOnce(() => {
        deleting.resolve();
        return cleanup.promise;
    });
    const answer = ask();
    await deleting.promise;
    expect(released).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(answer).resolves.toBe("A title");
    expect(released).toHaveBeenCalledTimes(1);
});

test("cancellation aborts the helper and releases its lease after cleanup", async () => {
    answering([]);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof prompt>>>();
    prompt.mockImplementationOnce(() => {
        started.resolve();
        return reply.promise;
    });
    aborted.mockImplementationOnce(async () => reply.reject(new Error("request aborted")));
    const failed = ask(controller.signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    await started.promise;
    controller.abort();
    expect(await failed).toMatchObject({ message: "request aborted" });
    expect(aborted).toHaveBeenCalledWith({ path: { id: "ses_1" } });
    expect(removed).toHaveBeenCalledWith({ path: { id: "ses_1" } });
    expect(released).toHaveBeenCalledTimes(1);
});

test("the helper deadline aborts its session and releases its lease", async () => {
    answering([]);
    jest.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof prompt>>>();
    prompt.mockImplementationOnce(() => {
        started.resolve();
        return reply.promise;
    });
    aborted.mockImplementationOnce(async () => reply.reject(new Error("request aborted")));
    const failed = ask().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    await started.promise;
    await advanceTimersByTimeAsync(20_000);
    expect(await failed).toMatchObject({ message: "the model did not answer within 20s" });
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith({ path: { id: "ses_1" } });
    expect(released).toHaveBeenCalledTimes(1);
});
