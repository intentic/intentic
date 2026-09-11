// @vitest-environment jsdom
import type { SandboxSettings, SavingsReport } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, expect, test, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const settings = ref<SandboxSettings>(SandboxSettingsSchema.parse({}));
const patch = vi.fn((fields: Partial<SandboxSettings>) => {
    settings.value = { ...settings.value, ...fields };
});

const savings = ref<SavingsReport | undefined>(undefined);

vi.mock(`../../overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({ settings, patch, dropped: ref(undefined), error: ref(undefined), isLoading: ref(false), save: { mutate: patch } }),
}));

vi.mock(`../../usage/useSavings`, () => ({
    useSavings: () => ({ savings, isLoading: ref(false), refetch: vi.fn(), error: ref(undefined) }),
}));

const { default: AgentDependencies } = await import("./AgentDependencies.vue");

let app: App | undefined;

const mount = (): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentDependencies) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    settings.value = SandboxSettingsSchema.parse({});
    savings.value = undefined;
    patch.mockClear();
});

test("draws the options and defaults to off", () => {
    const host = mount();
    expect(host.textContent).toContain("Check versions against the registry");
    expect(host.textContent).toContain("Nothing is looked up, and no registry is contacted.");
    expect(host.textContent).not.toContain("Recent improvements");
});

test("shows 'Nothing yet' verdict when freshness is enabled but no dependencies checked", async () => {
    settings.value = { ...settings.value, dependencyFreshness: "full" };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain("Nothing yet");
    expect(host.textContent).toContain("no dependencies checked so far");
});

test("shows recent improvements when freshness is active and reports improvements", async () => {
    settings.value = { ...settings.value, dependencyFreshness: "full" };
    savings.value = {
        input: {
            commands: 10,
            rawTokens: 1000,
            emittedTokens: 800,
            savedPct: 20,
            perCleaner: [],
            holdout: { cleaned: 10, heldOut: 0 },
            gaps: [],
        },
        dependencies: {
            checked: 8,
            improved: 3,
            updatedAt: Date.now() - 60_000,
            recent: [
                { prevented: "moment@2.29.4", chosen: "date-fns", reason: "moment is in maintenance mode and ships no new features" },
                { prevented: "request@2.88.2", chosen: "undici", reason: "it was deprecated in 2020 and takes no fixes" },
            ],
        },
    };
    const host = mount();
    await nextTick();

    expect(host.textContent).toContain("3");
    expect(host.textContent).toContain("improvements made (3 of 8 pins improved)");
    expect(host.textContent).toContain("Recent improvements");
    expect(host.textContent).toContain("moment@2.29.4");
    expect(host.textContent).toContain("date-fns");
    expect(host.textContent).toContain("request@2.88.2");
    expect(host.textContent).toContain("undici");
});
