import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { runCursorOneShot } from "./one-shot-cursor.js";

const created = vi.fn<(options: unknown) => Promise<{ send: typeof send; close: () => void }>>();
const send = vi.fn<(prompt: string, options: unknown) => Promise<{ wait: typeof wait; cancel: () => Promise<void> }>>();
const wait = vi.fn<() => Promise<{ status: string; error?: { message?: string } }>>();
const cancel = vi.fn<() => Promise<void>>();
const close = vi.fn<() => void>();

vi.mock("../cursor/cursor-sdk.js", () => ({
    CURSOR_SDK_MISSING: `missing sdk`,
    cursorSdk: async () => ({
        Agent: { create: created },
        RateLimitError: class RateLimitError extends Error {},
        AuthenticationError: class AuthenticationError extends Error {},
    }),
}));

const services = (): Services =>
    unstubbed<Services>(`services`, {
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, {
            credentials: async () => [{ id: `cursor-one`, apiKey: `key`, connectedAt: 0 }],
        }),
        cursorModels: unstubbed<Services[`cursorModels`]>(`cursorModels`, {
            models: async () => ({ models: [{ id: `composer-2.5`, label: `Composer 2.5` }], default: `composer-2.5` }),
            item: async () => undefined,
        }),
    });

const ask = (): Promise<string> =>
    runCursorOneShot({
        services: services(),
        prompt: `fix: name the change`,
        cwd: `/work`,
        model: `composer-2.5`,
        signal: new AbortController().signal,
    });

beforeEach(() => {
    vi.clearAllMocks();
    created.mockImplementation(async () => ({ send, close }));
    send.mockImplementation(async (_prompt, options) => {
        const onDelta = (options as { onDelta?: (input: { update: { type: string; text: string } }) => void }).onDelta;
        onDelta?.({ update: { type: `text-delta`, text: `fix: tree truncation` } });
        return { wait, cancel };
    });
    wait.mockResolvedValue({ status: `success` });
    cancel.mockResolvedValue(undefined);
});

/* The empty ALLOWLIST is the assertion, and `disallowedTools` being absent is half of it. Cursor validates tool
 * names against a vocabulary it reads from its own proto at runtime and refuses the whole run on one it does not
 * know; the denylist this replaced named `write`, which is not in it, so every walk that reached Composer threw
 * before asking it and fell through to a Claude rung. A list of names is a list of things to get wrong. */
test("asks on Cursor's own runtime with no tools rather than a list of names to deny", async () => {
    await expect(ask()).resolves.toBe(`fix: tree truncation`);

    expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
            apiKey: `key`,
            tools: [],
            local: expect.objectContaining({ cwd: `/work`, settingSources: [] }),
        }),
    );
    expect(created.mock.calls[0]?.[0]).not.toHaveProperty(`disallowedTools`);
    expect(send).toHaveBeenCalledWith(`fix: name the change`, expect.objectContaining({ onDelta: expect.any(Function) }));
    expect(close).toHaveBeenCalledOnce();
});

test("a reply carrying no text is a rung that did not answer", async () => {
    send.mockImplementation(async () => ({ wait, cancel }));
    wait.mockResolvedValue({ status: `success` });

    await expect(ask()).rejects.toThrow(/did not answer/);
    expect(close).toHaveBeenCalledOnce();
});

test("refuses when no Cursor account is connected", async () => {
    const empty = unstubbed<Services>(`services`, {
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, { credentials: async () => [] }),
        cursorModels: unstubbed<Services[`cursorModels`]>(`cursorModels`, {
            models: async () => ({ models: [{ id: `composer-2.5`, label: `Composer 2.5` }], default: `composer-2.5` }),
            item: async () => undefined,
        }),
    });

    await expect(
        runCursorOneShot({
            services: empty,
            prompt: `fix: name the change`,
            cwd: `/work`,
            model: `composer-2.5`,
            signal: new AbortController().signal,
        }),
    ).rejects.toThrow(/Connect your Cursor subscription/);
});
