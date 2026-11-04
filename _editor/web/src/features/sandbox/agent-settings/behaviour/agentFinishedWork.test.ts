// The back-up switch (2026-11-04): it pushes what a land's version committed, so it stands only beside Save a version,
// and switching that off takes it along in the same save. jsdom: mounts the group over the real settings composable.
import "@intentic/testing/dom";
import { type Rule, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { stubGlobal, waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, ref } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import type { SandboxRpc } from "../../../../client/sandbox/sandboxRpc";

stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const get = jest.fn<SandboxRpc[`settings`][`get`]>();
const set = jest.fn<SandboxRpc[`settings`][`set`]>();
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ settings: { get, set } }) }));
jest.mock(`../../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true) }) }));

const { queryClient } = await import(`../../../../lib/queryPersistence`);
const { default: AgentFinishedWork } = await import(`./AgentFinishedWork.vue`);
const { autoPushRule, autoVersionRule } = await import(`../../../../models/sandbox/environment/rules`);

const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentFinishedWork);
    app.use(PrimeVue);
    app.use(VueQueryPlugin, { queryClient });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

beforeEach(() => {
    queryClient.clear();
    jest.resetAllMocks();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The switch on the row that carries `title`: the innermost block holding both is the row's own line.
const switchBeside = (el: HTMLElement, title: string): HTMLInputElement => {
    const holders = [...el.querySelectorAll<HTMLElement>(`div`)].filter(
        (node) => (node.textContent ?? ``).includes(title) && node.querySelector(`input[role="switch"]`) !== null,
    );
    return holders.at(-1)!.querySelector<HTMLInputElement>(`input[role="switch"]`)!;
};

// Kept as the daemon keeps it: read through the schema, answered on the next read.
const daemonHolding = (rules: Rule[]): void => {
    let stored: SandboxSettings = { ...DEFAULTS, rules };
    get.mockImplementation(async () => stored);
    set.mockImplementation(async (written) => {
        stored = SandboxSettingsSchema.parse(written);
        return { ok: true };
    });
};

const BACK_UP = `Back up each saved version`;
const SAVE = `Save a version of accepted work`;
// The rules the n-th save wrote, in order.
const written = (call: number) => set.mock.calls[call]?.[0]?.rules ?? [];
const ruleIds = (call: number): string[] => written(call).map((rule) => rule.id);

test(`without Save a version the back-up switch is off and cannot be turned on`, async () => {
    daemonHolding([]);
    const el = mount();
    await waitFor(() => expect(switchBeside(el, SAVE).disabled).toBe(false));
    expect(switchBeside(el, BACK_UP).disabled).toBe(true);
    expect(switchBeside(el, BACK_UP).getAttribute(`aria-checked`)).toBe(`false`);
});

test(`with Save a version on, the back-up switch writes its rule`, async () => {
    daemonHolding([autoVersionRule()]);
    const el = mount();
    await waitFor(() => expect(switchBeside(el, BACK_UP).disabled).toBe(false));

    switchBeside(el, BACK_UP).click();

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(ruleIds(0)).toEqual([`auto-version`, `auto-push`]);
    expect(written(0).find((rule) => rule.id === `auto-push`)?.action).toEqual({ kind: `builtin`, name: `push-landed` });
    await waitFor(() => expect(switchBeside(el, BACK_UP).getAttribute(`aria-checked`)).toBe(`true`));
});

test(`switching Save a version off takes the back-up with it, in one save`, async () => {
    daemonHolding([autoVersionRule(), autoPushRule()]);
    const el = mount();
    await waitFor(() => expect(switchBeside(el, BACK_UP).getAttribute(`aria-checked`)).toBe(`true`));

    switchBeside(el, SAVE).click();

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(ruleIds(0)).toEqual([]);
    await waitFor(() => expect(switchBeside(el, BACK_UP).disabled).toBe(true));
    expect(switchBeside(el, BACK_UP).getAttribute(`aria-checked`)).toBe(`false`);
});
