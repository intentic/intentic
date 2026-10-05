import type { SandboxSummary } from "@intentic/api-contract";
import { ref } from "vue";
import { createMemoryHistory, createRouter, type RouteLocationNormalized } from "vue-router";
import { sandboxSummary } from "../testing/sandboxSummary";
import { arriveOnSandbox, type SandboxArrivalHost } from "./sandboxArrival";

// The desktop app opens the workspace on one sandbox with `/?sandbox=<id>`. Against a real router in the shell's own
// shape, whose home redirects by the active sandbox: a sandbox the account lists is selected, the id leaves the address
// and nothing else does, and an id it does not list changes nothing but the address.

const nothing = { render: () => null };

const stage = (rows: readonly SandboxSummary[]) => {
    const active = ref(`mine`);
    const list = jest.fn(async () => rows);
    const select = jest.fn((id: string) => {
        active.value = id;
    });
    const missing = jest.fn();
    const scope = jest.fn();
    const sandbox: SandboxArrivalHost = { list, select, missing, scope };
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: `/`,
                component: nothing,
                beforeEnter: [(to: RouteLocationNormalized) => arriveOnSandbox(to, sandbox)],
                children: [
                    // The shell's home, decided by the active sandbox's role: a guest's is its chat.
                    { path: ``, redirect: () => (rows.find((row) => row.id === active.value)?.role === `guest` ? `/chat` : `/workspace`) },
                    { path: `workspace`, component: nothing },
                    { path: `chat`, component: nothing },
                ],
            },
        ],
    });
    return { active, list, select, missing, scope, router };
};

const MINE = sandboxSummary({ id: `mine`, lastSeenAt: `2026-09-23T10:00:00Z` });
const PROJECT = sandboxSummary({ id: `project`, lastSeenAt: `2026-09-28T10:00:00Z` });
const SHARED = sandboxSummary({ id: `shared`, role: `guest`, token: null, lastSeenAt: `2026-09-28T10:00:00Z` });

it(`selects a sandbox the account lists, and drops only the id from the address`, async () => {
    const { select, router } = stage([MINE, PROJECT]);

    await router.push(`/workspace?sandbox=project&focus=a1#top`);

    expect(select.mock.calls).toEqual([[`project`]]);
    expect(router.currentRoute.value.fullPath).toBe(`/workspace?focus=a1#top`);
});

// The home redirect ran before the guard, for the sandbox active then; replaying the link lands where the named one's
// home is instead.
it(`lands on the named sandbox's own home`, async () => {
    const { active, router } = stage([MINE, SHARED]);

    await router.push(`/?sandbox=shared`);

    expect({ active: active.value, at: router.currentRoute.value.fullPath }).toEqual({ active: `shared`, at: `/chat` });
});

it(`ignores an id the account does not list, and drops it all the same`, async () => {
    const { active, select, router } = stage([MINE]);

    await router.push(`/?sandbox=someone-elses&focus=a1`);

    expect(select).not.toHaveBeenCalled();
    expect({ active: active.value, at: router.currentRoute.value.fullPath }).toEqual({ active: `mine`, at: `/workspace?focus=a1` });
});

// A local window lists the sandboxes the workspace last saw, so a row removed since lands here: on the sandbox open
// before, which the reader did not pick, so they are told why.
it(`says so once when the named sandbox is not listed, and never when it is`, async () => {
    const gone = stage([MINE]);
    await gone.router.push(`/?sandbox=removed-since`);
    expect(gone.missing).toHaveBeenCalledTimes(1);

    const listed = stage([MINE, PROJECT]);
    await listed.router.push(`/?sandbox=project`);
    expect(listed.missing).not.toHaveBeenCalled();
});

// vue-router hands a repeated key back as an array, which is no one sandbox's id.
it(`ignores an id given twice`, async () => {
    const { select, missing, router } = stage([MINE, PROJECT]);

    await router.push(`/workspace?sandbox=mine&sandbox=project`);

    expect(select).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(`/workspace`);
});

it(`leaves a link that names no sandbox alone, without listing anything`, async () => {
    const { list, router } = stage([MINE]);

    await router.push(`/workspace?focus=a1`);

    expect(list).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(`/workspace?focus=a1`);
});

// The desktop app opens a project's sandbox from the folder's own window with `&project=<folder>`: the workspace opens on
// that folder, not on the `/work` around it, which the owner read as "a sandbox in the parent of the folder I was viewing"
// (2026-10-05). The folder leaves the address with the id.
describe(`a project's sandbox opened from its folder`, () => {
    it(`opens the named sandbox on the folder, and drops both from the address`, async () => {
        const { select, scope, router } = stage([MINE, PROJECT]);

        await router.push(`/?sandbox=project&project=test-remove-me`);

        expect({ selected: select.mock.calls, scoped: scope.mock.calls }).toEqual({
            selected: [[`project`]],
            scoped: [[`project`, `test-remove-me`]],
        });
        expect(router.currentRoute.value.fullPath).toBe(`/workspace`);
    });

    it(`scopes to nothing a project folder cannot be called, and nothing for a sandbox the account lacks`, async () => {
        const named = stage([MINE, PROJECT]);
        await named.router.push(`/?sandbox=project&project=..%2Fetc`);
        await named.router.push(`/?sandbox=project&project=public`);
        expect(named.scope).not.toHaveBeenCalled();

        const gone = stage([MINE]);
        await gone.router.push(`/?sandbox=removed-since&project=app`);
        expect(gone.scope).not.toHaveBeenCalled();
    });
});

// The desktop app makes a folder's sandbox itself, so the page's list (kept for half a minute) may not hold it yet when
// the folder's window opens it: it is asked for once more before the reader is told it is gone.
describe(`a sandbox made since the page last listed the account's`, () => {
    it(`is looked for once more, past the cache, and opened`, async () => {
        const fresh = sandboxSummary({ id: `just-made`, lastSeenAt: `2026-10-05T10:00:00Z` });
        const { select, missing, router } = stage([MINE]);
        const refresh = jest.fn(async () => [MINE, fresh]);
        router.beforeEach(() => true);
        await router.push(`/`);
        const host: SandboxArrivalHost = { list: async () => [MINE], refresh, select, missing };
        const arrived = await arriveOnSandbox(router.resolve(`/?sandbox=just-made&project=app`), host);
        expect({ refreshed: refresh.mock.calls.length, selected: select.mock.calls, missing: missing.mock.calls.length, arrived }).toEqual({
            refreshed: 1,
            selected: [[`just-made`]],
            missing: 0,
            arrived: { path: `/`, query: {}, hash: `` },
        });
    });

    it(`is not asked for again when the cached list already holds it`, async () => {
        const refresh = jest.fn(async () => [MINE, PROJECT]);
        const select = jest.fn();
        const { router } = stage([MINE, PROJECT]);
        await arriveOnSandbox(router.resolve(`/?sandbox=project`), { list: async () => [MINE, PROJECT], refresh, select });
        expect({ refreshed: refresh.mock.calls.length, selected: select.mock.calls }).toEqual({ refreshed: 0, selected: [[`project`]] });
    });
});
