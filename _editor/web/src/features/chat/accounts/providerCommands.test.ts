// ensureProviderCommands: asks for the given provider (not just Claude), retries while the list is
// empty, never re-reads once populated, and drops an answer that arrives after a sandbox switch.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { it, expect, beforeEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import type { ProcedureInput } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const reads = hoisted(() => ({ answer: [] as { name: string; description: string }[] }));

// The one seam under test: a provider's commands as the daemon last recorded them. Any other read throws naming itself.
const commandReads = mock(async (_input: ProcedureInput<`agent.commands`>) => ({ commands: reads.answer }));
mock.module(`../../sandbox/client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ agent: { commands: commandReads } }) }));

import { providerCommands } from "./providerCatalog";
import { ensureProviderCommands } from "../models/useChat-catalog";

beforeEach(() => {
    commandReads.mockClear();
    reads.answer = [{ name: `compact`, description: `Summarize the conversation` }];
    resetSandboxScope();
});

// loadAccountStatus only ever asked for `claude`, so any other provider's pane read an empty record
// regardless of its daemon.
it(`asks for the provider it was given, not only claude`, async () => {
    await ensureProviderCommands(`cursor`);

    expect(commandReads.mock.calls).toEqual([[{ agent: `cursor` }]]);
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

    expect(commandReads.mock.calls).toEqual([[{ agent: `claude` }], [{ agent: `claude` }]]);
    expect(providerCommands.value[`claude`]).toHaveLength(1);
});

// A populated list is final for this daemon's life; the composer calls this on every keystroke, so
// re-reading each time would cost a request per slash.
it(`never re-reads a list it already has`, async () => {
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);
    await ensureProviderCommands(`claude`);

    expect(commandReads.mock.calls).toEqual([[{ agent: `claude` }]]);
});

// Concurrent askers share one request rather than each opening its own.
it(`shares one request between concurrent askers`, async () => {
    await Promise.all([ensureProviderCommands(`claude`), ensureProviderCommands(`claude`), ensureProviderCommands(`claude`)]);

    expect(commandReads.mock.calls).toEqual([[{ agent: `claude` }]]);
});

// A read in flight when the sandbox changes answers for the box the user left; applying it risks an
// unknown `/name` that discards the rest of the message.
it(`drops an answer that arrives after a sandbox switch`, async () => {
    const inFlight = ensureProviderCommands(`claude`);
    resetSandboxScope();
    await inFlight;

    expect(providerCommands.value[`claude`]).toEqual([]);
});
