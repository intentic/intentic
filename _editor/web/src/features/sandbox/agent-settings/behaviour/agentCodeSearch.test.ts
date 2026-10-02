// The report this pins: on one machine every switch in Code search flicked on and straight back off, and nothing said
// why. The daemon refused each write, and the page rolled it back while keeping the reason to itself. jsdom: mounts the
// group over the real settings composable, against a daemon that refuses.
import "@intentic/testing/dom";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/api-contract";
import { stubGlobal, waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, ref } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import { SandboxHttpError } from "../../client/sandboxHttpError";
import type { SandboxRpc } from "../../client/sandboxRpc";

stubGlobal(`localStorage`, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const get = jest.fn<SandboxRpc[`settings`][`get`]>();
const set = jest.fn<SandboxRpc[`settings`][`set`]>();
jest.mock(`../../client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ settings: { get, set } }) }));
jest.mock(`../../client/useSandbox`, () => ({ useSandbox: () => ({ reachable: ref(true) }) }));
// The group's two other reads, which say nothing about a save.
jest.mock(`../../usage/useSavings`, () => ({ useSavings: () => ({ savings: ref(undefined) }) }));
jest.mock(`./useFieldNotes`, () => ({ useFieldNotes: () => ({ status: ref(undefined) }) }));

const { queryClient } = await import(`../../../../lib/queryPersistence`);
const { default: AgentCodeSearch } = await import(`./AgentCodeSearch.vue`);

const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp(AgentCodeSearch);
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

test(`a switch the daemon refuses comes back off and says why, under its own group`, async () => {
    // What a daemon answers over a settings.json its build cannot read: the read served defaults, and every write is refused.
    const unreadable = `settings.json could not be read by this build (the file does not match what this build expects); fix or remove the file before anything can be written to it`;
    get.mockResolvedValue(DEFAULTS);
    set.mockRejectedValue(new SandboxHttpError(409, unreadable));
    const el = mount();
    await waitFor(() => expect(switchBeside(el, `Project map`).disabled).toBe(false));
    expect(el.textContent).not.toContain(`Couldn't save`);

    switchBeside(el, `Project map`).click();

    await waitFor(() => expect(el.textContent).toContain(unreadable));
    expect(el.textContent).toContain(`Couldn't save your change`);
    expect(set).toHaveBeenCalledWith({ ...DEFAULTS, workspaceMap: true });
    expect(switchBeside(el, `Project map`).getAttribute(`aria-checked`)).toBe(`false`);
});

test(`a save that lands keeps the switch on and says nothing`, async () => {
    let stored = DEFAULTS;
    get.mockImplementation(async () => stored);
    // Kept as the daemon keeps it: read through the schema.
    set.mockImplementation(async (written) => {
        stored = SandboxSettingsSchema.parse(written);
        return { ok: true };
    });
    const el = mount();
    await waitFor(() => expect(switchBeside(el, `iq code search`).disabled).toBe(false));

    switchBeside(el, `iq code search`).click();

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(switchBeside(el, `iq code search`).getAttribute(`aria-checked`)).toBe(`true`));
    expect(el.textContent).not.toContain(`Couldn't save`);
});
