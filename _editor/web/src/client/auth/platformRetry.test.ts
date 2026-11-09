// The way off the "Intentic isn't reachable" screen. The screen is a URL, so a reader can reload it, restore the tab
// or open it from history — each of those has to ask the platform again, or the URL itself becomes the trap.
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createMemoryHistory, createRouter, type RouteLocationNormalized } from "vue-router";

const refresh = jest.fn<() => Promise<{ id: string } | null>>();
jest.mock(`./useAuth`, () => ({ useAuth: () => ({ refresh }) }));
// What this device remembers of the account (deviceDirectory.ts): nothing, unless a test says otherwise.
let remembered: { sandboxes: readonly unknown[] } | undefined;
jest.mock(`../directory/deviceDirectory`, () => ({ rememberedAccount: () => remembered }));

const { ENTRY_BUDGET_MS, platformRetry, retryOnEntry } = await import(`./platformRetry`);

const entry = (returnTo: string, redirected = false): RouteLocationNormalized =>
    ({ query: { returnTo }, redirectedFrom: redirected ? { fullPath: returnTo } : undefined }) as unknown as RouteLocationNormalized;

beforeEach(() => {
    refresh.mockReset();
    remembered = undefined;
});

afterEach(() => {
    jest.useRealTimers();
});

it(`sends a reader back to the page they were headed for`, async () => {
    refresh.mockResolvedValue({ id: `user_1` });

    await expect(platformRetry(`/workspace`)).resolves.toBe(`/workspace`);
});

// A platform that answers "no session" is a real answer, so the screen is left for the destination, whose own guard
// rules on the session as a cold load's would (requireAuth): never back to the outage screen, and never to sign-in ahead
// of a page that admits a reader without one (below).
it(`hands the destination to its own guard when the platform answers that there is no session`, async () => {
    refresh.mockResolvedValue(null);

    await expect(platformRetry(`/workspace`)).resolves.toBe(`/workspace`);
});

it(`stays put while the platform still can't answer`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));

    await expect(platformRetry(`/workspace`)).resolves.toBeUndefined();
});

// The destination is attacker-reachable (it's a query param on an unguarded URL); signIn.ts's returnPath owns the rule.
it(`refuses a destination that would leave this origin`, async () => {
    refresh.mockResolvedValue({ id: `user_1` });

    await expect(platformRetry(`//evil.example`)).resolves.toBe(`/`);
});

// The bug this exists for: a reload on the screen used to re-render the failure without asking anything, so only the
// button could ever leave it.
it(`retries on a reload onto the screen, exactly like the button`, async () => {
    refresh.mockResolvedValue({ id: `user_1` });

    await expect(retryOnEntry(entry(`/workspace`))).resolves.toBe(`/workspace`);
    expect(refresh).toHaveBeenCalledTimes(1);
});

it(`draws the screen when a reload finds the platform still down`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));

    await expect(retryOnEntry(entry(`/workspace`))).resolves.toBe(true);
});

// (2026-11-09) A device that remembers the account has somewhere to go without the platform: the page it was headed for,
// whose guard opens the workspace on what it remembers (sessionGuard.ts).
it(`goes on to the page when a reload finds the platform down but the device remembers sandboxes`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));
    remembered = { sandboxes: [{ id: `s1` }] };

    await expect(retryOnEntry(entry(`/workspace`))).resolves.toBe(`/workspace`);
});

it(`draws the screen when the device remembers the account but no sandbox of it`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));
    remembered = { sandboxes: [] };

    await expect(retryOnEntry(entry(`/workspace`))).resolves.toBe(true);
});

// A platform that accepts the connection and then says nothing is the worst case for a boot: nothing to render until
// it answers. The screen is drawn on the budget instead, and keeps asking from there.
it(`draws the screen rather than holding the boot while the platform hangs`, async () => {
    jest.useFakeTimers();
    refresh.mockReturnValue(new Promise(() => undefined));

    const entering = retryOnEntry(entry(`/workspace`));
    await advanceTimersByTimeAsync(ENTRY_BUDGET_MS);

    await expect(entering).resolves.toBe(true);
});

// Arriving by redirect means a session check failed a moment ago; asking again in the same breath would only repeat it.
it(`doesn't re-ask when a check that just failed sent the reader here`, async () => {
    await expect(retryOnEntry(entry(`/workspace`, true))).resolves.toBe(true);
    expect(refresh).not.toHaveBeenCalled();
});

// The rule above reads `redirectedFrom`, which only the router sets, so the two cases are worth proving against a real
// one: the app's own shape, a guarded page that bounces an unreachable platform onto the screen.
const nothing = { render: () => null };
const routerWith = (reachable: () => boolean) =>
    createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: `/workspace`,
                component: nothing,
                beforeEnter: () => (reachable() ? true : { path: `/platform-unavailable`, query: { returnTo: `/workspace` } }),
            },
            { path: `/platform-unavailable`, component: nothing, beforeEnter: [retryOnEntry] },
        ],
    });

it(`asks once, not twice, when a failed page hands the reader over`, async () => {
    refresh.mockRejectedValue(new Error(`offline`));
    const router = routerWith(() => false);

    await router.push(`/workspace`);

    expect(router.currentRoute.value.path).toBe(`/platform-unavailable`);
    expect(refresh).not.toHaveBeenCalled();
});

// The whole point, end to end: the same URL the reader was stuck on, opened cold, now lands them in the app.
it(`carries a reload straight through to the page once the platform is back`, async () => {
    refresh.mockResolvedValue({ id: `user_1` });
    const router = routerWith(() => true);

    await router.push(`/platform-unavailable?returnTo=/workspace`);

    expect(router.currentRoute.value.path).toBe(`/workspace`);
});

// Signed out, the platform back: each page lands as a cold load with the platform up would land it. A page that needs a
// session goes to sign-in carrying itself; Home, which a signed-out reader may open (requireAuth), stays Home with no
// sign-in prompt over it (e2e-signin, run 42383887317: the prompt covered Home's own Sign in).
const signedOutRouter = () =>
    createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: `/home`, component: nothing },
            { path: `/workspace`, component: nothing, beforeEnter: (to) => ({ path: `/login`, query: { returnTo: to.fullPath } }) },
            { path: `/login`, component: nothing },
            { path: `/platform-unavailable`, component: nothing, beforeEnter: [retryOnEntry] },
        ],
    });

it(`sends a signed-out reader to sign-in from a page that needs a session once the platform is back`, async () => {
    refresh.mockResolvedValue(null);
    const router = signedOutRouter();

    await router.push(`/platform-unavailable?returnTo=/workspace`);

    expect(router.currentRoute.value.fullPath).toBe(`/login?returnTo=/workspace`);
});

it(`leaves a signed-out reader on Home once the platform is back`, async () => {
    refresh.mockResolvedValue(null);
    const router = signedOutRouter();

    await router.push(`/platform-unavailable?returnTo=/home`);

    expect(router.currentRoute.value.fullPath).toBe(`/home`);
});
