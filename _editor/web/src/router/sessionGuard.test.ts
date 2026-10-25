import type { User } from "@intentic/api-contract";
import { ref } from "vue";
import type { RouteLocationNormalized } from "vue-router";

const user = ref<User | null>(null);
const refresh = jest.fn<() => Promise<User | null>>();
jest.mock(`../client/auth/useAuth`, () => ({ useAuth: () => ({ user, refresh }) }));

const { requireAuth } = await import("./sessionGuard");

// SAFETY: requireAuth reads only path, query and fullPath; these tests do not navigate the partial route.
const route = (fullPath: string): RouteLocationNormalized =>
    ({ path: fullPath.split(`?`)[0], fullPath, query: Object.fromEntries(new URLSearchParams(fullPath.split(`?`)[1] ?? ``)) }) as RouteLocationNormalized;

beforeEach(() => {
    user.value = null;
    refresh.mockReset().mockResolvedValue(null);
});

it.each([`/home`, `/home/missing`, `/home?add=sandbox`])(`opens %s to a signed-out reader`, async (path) => {
    expect(await requireAuth(route(path))).toBe(true);
});

it.each([`/`, `/agents`, `/settings`])(`still asks for sign-in before %s`, async (path) => {
    expect(await requireAuth(route(path))).toEqual(path === `/` ? `/login` : { path: `/login`, query: { returnTo: path } });
});

// The bare address lands on Home, a link naming a sandbox included (`/?sandbox=<id>` → `/home?sandbox=<id>`): that one
// is about a sandbox of an account's, so it is signed in first and comes back to it.
it(`asks for sign-in before a link naming a sandbox, though it lands on Home, and comes back to the link itself`, async () => {
    expect(await requireAuth(route(`/home?sandbox=box-1`))).toEqual({ path: `/login`, query: { returnTo: `/home?sandbox=box-1` } });
    // SAFETY: as `route` above, a partial location the guard reads only path, query, fullPath and redirectedFrom of.
    const redirected = { ...route(`/home?sandbox=box-1`), redirectedFrom: route(`/?sandbox=box-1`) } as RouteLocationNormalized;
    expect(await requireAuth(redirected)).toEqual({ path: `/login`, query: { returnTo: `/?sandbox=box-1` } });
});

it(`does not mistake an unavailable platform for signed-out home`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));

    expect(await requireAuth(route(`/home`))).toEqual({ path: `/platform-unavailable`, query: { returnTo: `/home` } });
});
