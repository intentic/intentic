// A scope's doors aim where its id says at the moment of each call, and a scope of the active sandbox is the active
// sandbox itself: no `at`, the same key, so one read is never two entries.
import { unref } from "vue";
import * as actualSandboxRpc from "../sandboxRpc";
import type { ProcedureInput, ProcedureOutput, SandboxCallContext } from "../sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { inSetup, provided } from "../../../testing/inSetup";

const attentionMine = jest.fn<(input: ProcedureInput<`agents.attentionMine`>, options?: { context?: SandboxCallContext }) => Promise<ProcedureOutput<`agents.attentionMine`>>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ agents: { attentionMine } }) }));

const { activeSandboxId } = await import("../../../app/storage/activeSandbox");
const { rpcKey } = await import("../../../lib/queryKeys");
const { activeSandboxScope, SANDBOX_SCOPE, sandboxScopeOf, useSandboxScope } = await import("./useSandboxScope");
const { dropSandboxScope, perSandbox } = await import("./perSandbox");

beforeEach(() => {
    attentionMine.mockReset().mockResolvedValue({ needsYou: 0, working: 0 });
    activeSandboxId.value = `a`;
});

it(`aims another sandbox's calls by id, as background, read at call time`, async () => {
    const scope = sandboxScopeOf(`b`);
    await scope.rpc.agents.attentionMine();
    expect(attentionMine.mock.calls[0]?.[1]?.context).toEqual({ at: `b`, background: true });
    // The window switched to it: the same scope now aims nowhere, and its key is the active one's.
    activeSandboxId.value = `b`;
    await scope.rpc.agents.attentionMine();
    expect(attentionMine.mock.calls[1]?.[1]?.context).toEqual({ background: true });
    expect(scope.at()).toBeUndefined();
    // `rpcKey` carries the active id as a ref, which vue-query reads through.
    expect(scope.key(`agents.attentionMine`)).toEqual(rpcKey(`agents.attentionMine`).map((part) => unref(part)));
});

it(`keeps a call's own context over the scope's`, async () => {
    await sandboxScopeOf(`b`).rpc.agents.attentionMine(undefined, { context: { background: false } });
    expect(attentionMine.mock.calls[0]?.[1]?.context).toEqual({ at: `b`, background: false });
});

it(`answers one scope per id, and the active one where nothing is provided`, () => {
    expect(sandboxScopeOf(`b`)).toBe(sandboxScopeOf(`b`));
    expect(useSandboxScope()).toBe(activeSandboxScope);
    expect(inSetup(() => useSandboxScope()).result).toBe(activeSandboxScope);
    const scope = sandboxScopeOf(`c`);
    expect(inSetup(() => useSandboxScope(), { provides: [provided(SANDBOX_SCOPE, scope)] }).result).toBe(scope);
});

it(`forgets an id's state when it is dropped, and makes it afresh on the next ask`, () => {
    const disposed: string[] = [];
    const counts = perSandbox((id) => ({ id }), (_value, id) => disposed.push(id));
    const first = counts.of(`b`);
    expect(counts.of(`b`)).toBe(first);
    dropSandboxScope(`b`);
    expect(disposed).toEqual([`b`]);
    expect(counts.of(`b`)).not.toBe(first);
});
