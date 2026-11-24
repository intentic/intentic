// A tile's attention count read through the sandbox it stands in: outside any `<InSandbox>` the active sandbox's entry,
// inside one for another sandbox that sandbox's, asked of its daemon by id, in the entry Home's readings share.
import { waitFor } from "@intentic/testing/bun";
import * as actualSandboxRpc from "../../client/sandbox/sandboxRpc";
import type { ProcedureInput, ProcedureOutput, SandboxCallContext } from "../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";
import { inSetup, provided } from "../../testing/inSetup";
import { sandboxSummary } from "../../testing/sandboxSummary";

const attentionMine = jest.fn<(input: ProcedureInput<`agents.attentionMine`>, options?: { context?: SandboxCallContext }) => Promise<ProcedureOutput<`agents.attentionMine`>>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ agents: { attentionMine } }) }));

// What a failed read reports durably, watched rather than sent.
const reportClient = jest.fn();
const realDiagnostics = { ...(await import("../../app/clientDiagnostics")) };
jest.mock(`../../app/clientDiagnostics`, () => ({ ...realDiagnostics, reportClient }));

const { queryClient } = await import("../../lib/queryPersistence");
const { useSandbox } = await import("../../client/sandbox/useSandbox");
const { useHomeAttention } = await import("./useHomeAttention");
const { activeSandboxId } = await import("../../app/storage/activeSandbox");
const { activeSandboxScope, SANDBOX_SCOPE, sandboxScopeOf } = await import("../../client/sandbox/scope/useSandboxScope");
const { attentionKey, attentionRead, useAttentionMine } = await import("./useAttentionMine");
const { dropEverySandboxScope } = await import("../../client/sandbox/scope/perSandbox");

let stop = (): void => undefined;
afterEach(() => {
    stop();
    dropEverySandboxScope();
    reportClient.mockReset();
    queryClient.clear();
    attentionMine.mockReset();
    activeSandboxId.value = undefined;
});

it(`reads the active sandbox's entry where no sandbox is provided`, async () => {
    activeSandboxId.value = `a`;
    queryClient.setQueryData(attentionKey(activeSandboxScope), { needsYou: 2, working: 0 });
    const mounted = inSetup(() => useAttentionMine());
    stop = mounted.stop;
    await waitFor(() => expect(mounted.result.query.data.value).toEqual({ needsYou: 2, working: 0 }));
    // The active scope's key and a scope of the active id's are one entry, never two.
    expect(queryClient.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([attentionKey(sandboxScopeOf(`a`))]);
});

it(`asks the provided sandbox by id, as background, and fills the entry Home's readings share`, async () => {
    activeSandboxId.value = `a`;
    attentionMine.mockResolvedValue({ needsYou: 5, working: 0 });
    const scope = sandboxScopeOf(`b`);
    const mounted = inSetup(() => useAttentionMine(), { provides: [provided(SANDBOX_SCOPE, scope)] });
    stop = mounted.stop;
    await waitFor(() => expect(mounted.result.query.data.value).toEqual({ needsYou: 5, working: 0 }));
    expect(attentionMine.mock.calls[0]?.[1]?.context).toEqual({ at: `b`, background: true });
    expect(queryClient.getQueryData(attentionKey(scope))).toEqual({ needsYou: 5, working: 0 });
});

// An asleep sandbox is an expected state its tile already shows dimmed: asked once a poll however many readers it has,
// never retried, never reported.
it(`asks an asleep sandbox once between the tile and Home's readings, without retrying or reporting it`, async () => {
    activeSandboxId.value = `a`;
    useSandbox().sandboxes.value = [sandboxSummary({ id: `b`, lastSeenAt: new Date(0).toISOString(), daemonUrl: `https://b.test` })];
    attentionMine.mockRejectedValue(new Error(`asleep`));
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    const scope = sandboxScopeOf(`b`);
    const tile = inSetup(() => useAttentionMine(), { provides: [provided(SANDBOX_SCOPE, scope)] });
    const home = inSetup(() => useHomeAttention({ everyMs: 60_000 }));
    stop = () => {
        tile.stop();
        home.stop();
        useSandbox().sandboxes.value = [];
    };
    // Dimmed at once, from the one failure: no retries run first.
    await waitFor(() => expect(home.result.value.get(`b`)).toEqual({ needsYou: undefined, unreachable: true }));
    await waitFor(() => expect(tile.result.query.status.value).toBe(`error`));
    expect(attentionMine).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().find({ queryKey: attentionKey(scope) })?.state.fetchFailureCount).toBe(1);
    expect(reportClient.mock.calls.filter(([name]) => name === `query.failed`)).toEqual([]);
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith(`query `))).toEqual([]);
    warn.mockRestore();
});

it(`shares one call's outcome inside the window, and asks again when told to`, async () => {
    activeSandboxId.value = `a`;
    attentionMine.mockRejectedValue(new Error(`asleep`));
    const scope = sandboxScopeOf(`b`);
    await expect(attentionRead(scope)).rejects.toThrow(`asleep`);
    await expect(attentionRead(scope)).rejects.toThrow(`asleep`);
    expect(attentionMine).toHaveBeenCalledTimes(1);
    attentionMine.mockResolvedValue({ needsYou: 1, working: 0 });
    await expect(attentionRead(scope, true)).resolves.toEqual({ needsYou: 1, working: 0 });
    expect(attentionMine).toHaveBeenCalledTimes(2);
});
