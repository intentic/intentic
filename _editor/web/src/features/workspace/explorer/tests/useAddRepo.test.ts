// A clone is the workspace's and runs for minutes, so the press only files it: the dialog closes, the notification lane
// follows it, and a receipt says when it landed. What is pinned: a clone keeps running with no form on screen, a second
// press on the same repository is refused (the daemon's answer to that was a misleading "already exists") while another
// repository clones beside it, a failure waits for the form that comes back with its address, and the lane says what
// runs and what failed only where no form already says it.
const clones = { answers: [] as { resolve: () => void; reject: (error: Error) => void }[] };

jest.mock("@tanstack/vue-query", () => ({
    useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        workspace: {
            addRepo: () =>
                new Promise((resolve, reject) => {
                    clones.answers.push({ resolve: () => resolve({ ok: true } as never), reject });
                }),
        },
    }),
}));

import { type EffectScope, effectScope, nextTick } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import { forgetOperations, operationsUnder } from "../../../../workbench/operations/operations";
import { useNotifications } from "../../../../workbench/notifications/notifications";
import { ADD_REPO, holdCloneNotice, shownAddress, useAddRepo } from "../useAddRepo";

const mount = (): { view: ReturnType<typeof useAddRepo>; scope: EffectScope } => {
    const scope = effectScope();
    const view = scope.run(() => useAddRepo())!;
    return { view, scope };
};

// The lane as the app holds it: the clone cards, read by id.
const lane = () => {
    const scope = effectScope();
    const release = scope.run(() => holdCloneNotice())!;
    const { notifications } = useNotifications();
    return {
        card: (id: string) => notifications.value.find((entry) => entry.id === id),
        stop: () => {
            release();
            scope.stop();
        },
    };
};

// The run's own settle, then the receipt raised after it.
const settled = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
    }
    await nextTick();
};

afterEach(() => {
    forgetOperations();
    clones.answers = [];
    useNotifications().dismissReceipt();
});

it(`files a clone and lets the form go, refusing a second press on the same repository while another clones beside it`, async () => {
    const first = mount();
    expect(first.view.addRepo(`https://github.com/owner/repo.git`)).toBe(true);
    first.scope.stop();

    const back = mount();
    expect(back.view.addRepo(`https://github.com/owner/repo`)).toBe(false);
    expect(back.view.failure.value?.title).toBe(`repo is already being cloned.`);
    expect(back.view.addRepo(`https://github.com/owner/other.git`)).toBe(true);
    expect(clones.answers).toHaveLength(2);
    expect(operationsUnder(ADD_REPO).map((run) => run.state)).toEqual([`running`, `running`]);

    clones.answers[0]!.resolve();
    await settled();
    // A clone that landed is put away, and said once, as a receipt.
    expect(operationsUnder(ADD_REPO)).toHaveLength(1);
    expect(useNotifications().receipt.value?.title).toBe(`Cloned repo into the workspace`);
    back.scope.stop();
});

it(`keeps a failed clone's notice and address for the form that comes back, and a new press puts it away`, async () => {
    const first = mount();
    first.view.addRepo(`git@host:owner/private`);
    first.scope.stop();
    clones.answers[0]!.reject(new Error(`Authentication failed for host`));
    await settled();
    expect(useNotifications().receipt.value).toBeUndefined();

    const back = mount();
    expect(back.view.failure.value).toMatchObject({ title: `Couldn't clone that repository.`, detail: `Authentication failed for host` });
    expect(back.view.failedUrl.value).toBe(`git@host:owner/private`);

    expect(back.view.addRepo(`https://host/owner/private.git`)).toBe(true);
    expect(back.view.failure.value).toBeUndefined();
    expect(operationsUnder(ADD_REPO).map((run) => run.state)).toEqual([`running`]);
    back.scope.stop();
});

it(`refuses an address with nothing to clone without sending it`, () => {
    const pane = mount();
    expect(pane.view.addRepo(`   `)).toBe(false);
    expect(pane.view.failure.value?.detail).toBe(`That doesn't look like a repository address.`);
    expect(clones.answers).toHaveLength(0);
    pane.scope.stop();
});

it(`says on the lane what is cloning and from where, and a failure only while no form says it`, async () => {
    const shown = lane();
    const form = mount();
    form.view.addRepo(`https://token@github.com/owner/repo.git`);
    form.scope.stop();

    expect(shown.card(`clone`)?.title).toBe(`Cloning repo`);
    // The address without its scheme, and without the credentials a pasted URL can carry.
    expect(shown.card(`clone`)?.detail?.startsWith(`github.com/owner/repo.git · `)).toBe(true);

    clones.answers[0]!.reject(new Error(`Repository not found`));
    await settled();
    expect(shown.card(`clone`)).toBeUndefined();
    expect(shown.card(`clone-failed`)).toMatchObject({ title: `Couldn't clone repo`, detail: `Repository not found` });

    // The dialog its press reopens says the failure itself.
    const reopened = mount();
    expect(shown.card(`clone-failed`)).toBeUndefined();
    reopened.scope.stop();
    shown.stop();
});

it(`counts clones running side by side on one card`, () => {
    const shown = lane();
    const form = mount();
    form.view.addRepo(`https://github.com/owner/one`);
    form.view.addRepo(`https://github.com/owner/two`);
    expect(shown.card(`clone`)?.title).toBe(`Cloning 2 repositories`);
    expect(shown.card(`clone`)?.detail?.startsWith(`one, two · `)).toBe(true);
    form.scope.stop();
    shown.stop();
});

it(`shows an address without its scheme or credentials`, () => {
    expect(shownAddress(`https://user:secret@gitlab.com/group/app.git`)).toBe(`gitlab.com/group/app.git`);
    expect(shownAddress(`git@github.com:owner/repo`)).toBe(`github.com:owner/repo`);
    expect(shownAddress(`ssh://git@host:22/repo.git`)).toBe(`host:22/repo.git`);
});
