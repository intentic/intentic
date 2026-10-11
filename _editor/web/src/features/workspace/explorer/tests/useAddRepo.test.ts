// A clone is the workspace's and runs for minutes; the empty pane that started it is gone the moment a file opens. What
// is pinned: a pane that comes back over a clone still running finds it running, with the address it was given, and
// cannot press it again (the daemon's answer to that was a misleading "already exists"); its failure waits too.
const clones = { answer: undefined as undefined | { resolve: () => void; reject: (error: Error) => void }, calls: 0 };

jest.mock("@tanstack/vue-query", () => ({
    useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        workspace: {
            addRepo: () => {
                clones.calls += 1;
                return new Promise((resolve, reject) => {
                    clones.answer = { resolve: () => resolve({ ok: true } as never), reject };
                });
            },
        },
    }),
}));

import { type EffectScope, effectScope } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import { forgetOperations } from "../../../../workbench/operations/operations";
import { useAddRepo } from "../useAddRepo";

const mount = (): { view: ReturnType<typeof useAddRepo>; scope: EffectScope } => {
    const scope = effectScope();
    const view = scope.run(() => useAddRepo())!;
    return { view, scope };
};

afterEach(() => {
    forgetOperations();
    clones.calls = 0;
    clones.answer = undefined;
});

it(`keeps a clone running through the pane that started it leaving, and refuses a second press`, async () => {
    const first = mount();
    const pressed = first.view.addRepo(`https://github.com/owner/repo.git`);
    expect(first.view.cloning.value).toBe(true);
    first.scope.stop();

    const back = mount();
    expect(back.view.cloning.value).toBe(true);
    expect(back.view.url.value).toBe(`https://github.com/owner/repo.git`);
    expect(await back.view.addRepo(`https://github.com/owner/repo.git`)).toBe(false);
    expect(clones.calls).toBe(1);

    clones.answer!.resolve();
    expect(await pressed).toBe(true);
    expect(back.view.cloning.value).toBe(false);
    expect(back.view.failure.value).toBeUndefined();
    back.scope.stop();
});

it(`keeps a failed clone's notice and address for the pane that comes back`, async () => {
    const first = mount();
    const pressed = first.view.addRepo(`git@host:owner/private`);
    first.scope.stop();
    clones.answer!.reject(new Error(`Authentication failed for host`));
    expect(await pressed).toBe(false);

    const back = mount();
    expect(back.view.failure.value).toMatchObject({ title: `Couldn't clone that repository.`, detail: `Authentication failed for host` });
    expect(back.view.url.value).toBe(`git@host:owner/private`);
    back.scope.stop();
});

it(`refuses an address with nothing to clone without sending it`, async () => {
    const pane = mount();
    expect(await pane.view.addRepo(`   `)).toBe(false);
    expect(pane.view.failure.value?.detail).toBe(`That doesn't look like a repository address.`);
    expect(clones.calls).toBe(0);
    pane.scope.stop();
});
