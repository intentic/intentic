import "@intentic/testing/dom";
import { h } from "vue";
import { createMemoryHistory, createRouter, type RouteLocationNormalized } from "vue-router";

// The start's hooks, against a real router in the shell's shape: a returning browser asks for the shell's chunks and the
// view's while the guards still run, a signed-out one asks for nothing, and the first landed navigation is the start's
// `guards` link.

const shellChunks = { loadWorkspaceShell: jest.fn(async () => ({})), loadShellDesktop: jest.fn(async () => ({})), loadShellMobile: jest.fn(async () => ({})) };
jest.mock(`../shell/shellChunks`, () => shellChunks);

const { activeSandboxId } = await import(`../app/storage/activeSandbox`);
const { asyncView } = await import(`../components/asyncView`);
const { installStartHooks } = await import(`./startHooks`);

const nothing = { render: () => null };

// Each stage's router holds a guard that records what had been asked for by the time it ran, then lets the call through.
const stage = () => {
    const viewLoad = jest.fn(async () => ({ default: { render: () => h(`div`) } }));
    const seenByGuard: string[] = [];
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/login`, component: nothing },
            {
                path: `/`,
                component: nothing,
                beforeEnter: [
                    (_to: RouteLocationNormalized) => {
                        if (shellChunks.loadWorkspaceShell.mock.calls.length > 0) {
                            seenByGuard.push(`shell`);
                        }
                        if (viewLoad.mock.calls.length > 0) {
                            seenByGuard.push(`view`);
                        }
                        return true;
                    },
                ],
                children: [{ path: `agents`, component: asyncView(viewLoad) }],
            },
        ],
    });
    installStartHooks(router);
    return { router, viewLoad, seenByGuard };
};

beforeEach(() => {
    for (const load of Object.values(shellChunks)) {
        load.mockClear();
    }
});

it(`asks for the shell, its chrome and the view before the shell's own guards run, on a browser that had a sandbox open`, async () => {
    activeSandboxId.value = `mine`;
    const { router, viewLoad, seenByGuard } = stage();
    await router.push(`/agents`);
    expect(seenByGuard).toEqual([`shell`, `view`]);
    expect(shellChunks.loadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(shellChunks.loadShellDesktop.mock.calls.length + shellChunks.loadShellMobile.mock.calls.length).toBe(1);
    expect(viewLoad).toHaveBeenCalledTimes(1);
});

it(`asks for nothing on a browser with no sandbox open, or for a page outside the shell`, async () => {
    activeSandboxId.value = undefined;
    const signedOut = stage();
    await signedOut.router.push(`/agents`);
    expect(shellChunks.loadWorkspaceShell).not.toHaveBeenCalled();
    expect(signedOut.viewLoad).not.toHaveBeenCalled();

    activeSandboxId.value = `mine`;
    const login = stage();
    await login.router.push(`/login`);
    expect(shellChunks.loadWorkspaceShell).not.toHaveBeenCalled();
});
