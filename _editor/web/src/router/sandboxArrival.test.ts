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
    const sandbox: SandboxArrivalHost = { list, select };
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
    return { active, list, select, router };
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

// vue-router hands a repeated key back as an array, which is no one sandbox's id.
it(`ignores an id given twice`, async () => {
    const { select, router } = stage([MINE, PROJECT]);

    await router.push(`/workspace?sandbox=mine&sandbox=project`);

    expect(select).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(`/workspace`);
});

it(`leaves a link that names no sandbox alone, without listing anything`, async () => {
    const { list, router } = stage([MINE]);

    await router.push(`/workspace?focus=a1`);

    expect(list).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(`/workspace?focus=a1`);
});
