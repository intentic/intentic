import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { cursorOneShot } from "./cursor-one-shot.js";

const created = vi.fn<(options: unknown) => Promise<{ send: typeof send; close: () => void }>>();
const send = vi.fn<(prompt: string, options: unknown) => Promise<{ wait: typeof wait; cancel: () => Promise<void> }>>();
const wait = vi.fn<() => Promise<{ status: string; error?: { message?: string } }>>();
const cancel = vi.fn<() => Promise<void>>();
const close = vi.fn<() => void>();

// One class per kind, not one per call: the runtime tells a spent allowance from any other failure by `instanceof`,
// and a factory minting a fresh class each time would answer no to every check.
class RateLimitError extends Error {}
class AuthenticationError extends Error {}

vi.mock("./cursor-sdk.js", () => ({
    CURSOR_SDK_MISSING: `missing sdk`,
    cursorSdk: async () => ({ Agent: { create: created }, RateLimitError, AuthenticationError }),
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
    cursorOneShot(services(), {
        provider: `cursor`,
        prompt: `fix: name the change`,
        cwd: WORKSPACE_ROOT,
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

/* The empty ALLOWLIST is the assertion, and `disallowedTools` being absent is half of it. */
test("asks on Cursor's own runtime with no tools rather than a list of names to deny", async () => {
    await expect(ask()).resolves.toBe(`fix: tree truncation`);

    expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
            apiKey: `key`,
            tools: [],
            local: expect.objectContaining({ cwd: WORKSPACE_ROOT, settingSources: [] }),
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

// Two accounts and the ledger between them, written by the helper and read back by its own next attempt.
const fleet = () => {
    const ledger: Record<string, Record<string, { at: number; message: string }>> = {};
    const refresh = vi.fn(async () => undefined);
    const deps = unstubbed<Services>(`services`, {
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, {
            credentials: async () => [
                { id: `one`, apiKey: `key-one`, connectedAt: 0 },
                { id: `two`, apiKey: `key-two`, connectedAt: 1 },
            ],
        }),
        cursorModels: unstubbed<Services[`cursorModels`]>(`cursorModels`, {
            models: async () => ({ models: [{ id: `composer-2.5`, label: `Composer 2.5` }], default: `composer-2.5` }),
            item: async () => undefined,
        }),
        observedLimits: unstubbed<Services[`observedLimits`]>(`observedLimits`, {
            spent: async (_provider, account) => ledger[account] ?? {},
            record: async (_provider, account, model, limit) => {
                ledger[account] = { ...ledger[account], [model]: limit };
            },
        }),
        headroom: unstubbed<Services[`headroom`]>(`headroom`, { refresh }),
    });
    return { ledger, refresh, deps };
};

const askOn = (deps: Services): Promise<string> =>
    cursorOneShot(deps, {
        provider: `cursor`,
        prompt: `fix: name the change`,
        cwd: WORKSPACE_ROOT,
        model: `composer-2.5`,
        signal: new AbortController().signal,
    });

// Which credential each run was opened on: the refusal below has to be one account's, not the model's.
const keysAsked = (): string[] => created.mock.calls.map((call) => (call[0] as { apiKey: string }).apiKey);

// Sends refuse on the named keys; every other key answers as the default stub does.
const refuseOn = (...keys: readonly string[]): void => {
    send.mockImplementation(async (_prompt, options) => {
        if (keys.includes(keysAsked().at(-1) ?? ``)) {
            throw new RateLimitError(`429 usage limit reached`);
        }
        const onDelta = (options as { onDelta?: (input: { update: { type: string; text: string } }) => void }).onDelta;
        onDelta?.({ update: { type: `text-delta`, text: `fix: tree truncation` } });
        return { wait, cancel };
    });
};

// The commit-message bug: the first account is out of Composer, and the allowance on the other went unused.
test("a spent allowance is filed against the one account, and the sibling answers", async () => {
    const { ledger, refresh, deps } = fleet();
    refuseOn(`key-one`);

    await expect(askOn(deps)).resolves.toBe(`fix: tree truncation`);

    expect(keysAsked()).toEqual([`key-one`, `key-two`]);
    expect(Object.keys(ledger[`one`] ?? {})).toEqual([`composer-2.5`]);
    expect(ledger[`two`]).toBeUndefined();
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ scope: { providers: [`cursor`], account: `one` } }));
});

test("a fleet entirely out of the model refuses in the vendor's own words, having asked each account once", async () => {
    const { ledger, deps } = fleet();
    refuseOn(`key-one`, `key-two`);

    await expect(askOn(deps)).rejects.toThrow(/429 usage limit reached/);
    expect(keysAsked()).toEqual([`key-one`, `key-two`]);
    expect(Object.keys(ledger).toSorted()).toEqual([`one`, `two`]);
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
        cursorOneShot(empty, {
            provider: `cursor`,
            prompt: `fix: name the change`,
            cwd: WORKSPACE_ROOT,
            model: `composer-2.5`,
            signal: new AbortController().signal,
        }),
    ).rejects.toThrow(/Connect your Cursor subscription/);
});
