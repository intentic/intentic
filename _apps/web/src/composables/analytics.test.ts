import type { Plan, User } from "@intentic-app/api-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

// Plain refs stand in for useAuth's module singletons; the mock factory closes over them so re-imported
// analytics modules (vi.resetModules per test) keep watching the same instances.
const user = ref<User | null>(null);
const plan = ref<Plan | undefined>(undefined);
const upgradeOpen = ref(false);
vi.mock("./useAuth", () => ({ useAuth: () => ({ user, plan, upgradeOpen }) }));
vi.mock("posthog-js", () => ({
    default: { init: vi.fn(), identify: vi.fn(), reset: vi.fn(), capture: vi.fn(), setPersonProperties: vi.fn() },
}));

const bootAnalytics = async (posthogKey: string) => {
    vi.resetModules();
    vi.stubGlobal(`window`, { env: { analytics: { posthogKey, posthogHost: `https://us.i.posthog.com` } } });
    const posthog = (await import(`posthog-js`)).default;
    const analytics = await import(`./analytics`);
    analytics.initAnalytics();
    return { posthog, analytics };
};

beforeEach(() => {
    // The posthog-js mock instance is shared across vi.resetModules boots — drop the previous test's calls.
    vi.clearAllMocks();
    user.value = null;
    plan.value = undefined;
    upgradeOpen.value = false;
});

describe(`initAnalytics`, () => {
    it(`stays inert without a key (dev) or with an unsubstituted envsubst placeholder`, async () => {
        const { posthog: empty } = await bootAnalytics(``);
        const { posthog: literal } = await bootAnalytics(`$POSTHOG_KEY`);
        expect(empty.init).not.toHaveBeenCalled();
        expect(literal.init).not.toHaveBeenCalled();
    });

    it(`identifies on session resolve, resets on sign-out, captures upgrade dialog opens`, async () => {
        const { posthog } = await bootAnalytics(`phc_test`);
        expect(posthog.init).toHaveBeenCalledWith(`phc_test`, expect.objectContaining({ persistence: `memory` }));

        user.value = { id: `u1`, email: `a@b.c`, name: `A`, image: null };
        await nextTick();
        expect(posthog.identify).toHaveBeenCalledWith(`u1`, { email: `a@b.c`, name: `A` });

        plan.value = `pro`;
        await nextTick();
        expect(posthog.setPersonProperties).toHaveBeenCalledWith({ plan: `pro` });

        upgradeOpen.value = true;
        await nextTick();
        expect(posthog.capture).toHaveBeenCalledWith(`upgrade_dialog_shown`);

        user.value = null;
        await nextTick();
        expect(posthog.reset).toHaveBeenCalled();
    });
});

describe(`track`, () => {
    it(`captures only when analytics is enabled`, async () => {
        const { posthog: disabled, analytics: inert } = await bootAnalytics(``);
        inert.track(`message_sent`);
        expect(disabled.capture).not.toHaveBeenCalled();

        const { posthog, analytics } = await bootAnalytics(`phc_test`);
        analytics.track(`message_sent`, { agent: `claude` });
        expect(posthog.capture).toHaveBeenCalledWith(`message_sent`, { agent: `claude` });
    });
});
