// @vitest-environment jsdom
// ensureProviderCommands: asks for the given provider (not just Claude), retries while the list is
// empty, never re-reads once populated, and drops an answer that arrives after a sandbox switch.
import { beforeEach, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: [] as string[], answer: [] as { name: string; description: string }[] }));

// The one seam under test; other paths answering empty stand in for a mounted chat's other fetches.
vi.mock(`../../sandbox/client/sandboxClient`, () => ({
    sandboxJson: vi.fn((path: string) => {
        reads.paths.push(path);
        return path.startsWith(`/agent/commands`) ? Promise.resolve({ commands: reads.answer }) : Promise.resolve({});
    }),
    sandboxRequest: vi.fn(() => Promise.resolve(new Response(`{}`))),
    sandboxRequestVia: vi.fn(() => Promise.resolve(new Response(`{}`))),
    sandboxError: vi.fn(() => new Error(`unused`)),
}));

import { providerCommands } from "./providerCatalog";
import { resetChat } from "../run/useChat";
import { ensureProviderCommands } from "../models/useChat-catalog";

const commandReads = (): string[] => reads.paths.filter((path) => path.startsWith(`/agent/commands`));

beforeEach(() => {
    reads.paths.length = 0;
    reads.answer = [{ name: `compact`, description: `Summarize the conversation` }];
    resetChat();
});

// loadAccountStatus only ever asked for `claude`, so any other provider's pane read an empty record
// regardless of its daemon.
it(`asks for the provider it was given, not only claude`, async () => {
    await ensureProviderCommands(`cursor`);

    expect(commandReads()).toEqual([`/agent/commands?agent=cursor`]);
    expect(providerCommands.value[`cursor`]).toEqual([{ name: `compact`, description: `Summarize the conversation` }]);
});

// The first read can land before any turn has run, answering empty; without a retry, the popover
// stays empty until reload.
it(`asks again while the list is still empty, so a read that came back too early self-heals`, async () => {
    reads.answer = [];
    await ensureProviderCommands(`claude`);
    expect(providerCommands.value[`claude`]).toEqual([]);

    reads.answer = [{ name: `compact`, description: `Summarize the conversation` }];
    await ensureProviderCommands(`claude`);

    expect(commandReads()).toHaveLength(2);
    expect(providerCommands.value[`claude`]).toHaveLength(1);
});

// A populated list is final for this daemon's life; the composer calls this on every keystroke, so
// re-reading each time would cost a request per slash.
it(`never re-reads a list it already has`, async () => {
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);

    expect(commandReads()).toHaveLength(1);
});

// Concurrent askers share one request rather than each opening its own.
it(`shares one request between concurrent askers`, async () => {
    await Promise.all([ensureProviderCommands(`claude`), ensureProviderCommands(`claude`), ensureProviderCommands(`claude`)]);

    expect(commandReads()).toHaveLength(1);
});

// A read in flight when the sandbox changes answers for the box the user left; applying it risks an
// unknown `/name` that discards the rest of the message.
it(`drops an answer that arrives after a sandbox switch`, async () => {
    const inFlight = ensureProviderCommands(`claude`);
    resetChat();
    await inFlight;

    expect(providerCommands.value[`claude`]).toEqual([]);
});
