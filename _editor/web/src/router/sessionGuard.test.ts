import type { User } from "@intentic/api-contract";
import { ref } from "vue";
import type { RouteLocationNormalized } from "vue-router";

const user = ref<User | null>(null);
const refresh = jest.fn<() => Promise<User | null>>();
jest.mock(`../client/auth/useAuth`, () => ({ useAuth: () => ({ user, refresh }) }));

const { requireAuth } = await import("./sessionGuard");

// SAFETY: requireAuth reads only path and fullPath; these tests do not navigate the partial route.
const route = (fullPath: string): RouteLocationNormalized => ({ path: fullPath.split(`?`)[0], fullPath }) as RouteLocationNormalized;

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

it(`does not mistake an unavailable platform for signed-out home`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));

    expect(await requireAuth(route(`/home`))).toEqual({ path: `/platform-unavailable`, query: { returnTo: `/home` } });
});
