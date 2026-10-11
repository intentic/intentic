// Bringing a sandbox in from a bundle: the upload that reads it and the apply that unpacks it both run for minutes, and
// the daemon holds the plan by token with no way to read it back. Pinned here: leaving the panel mid-read or after it
// and opening it again finds the same read still going, then the same checklist, and the report after an apply stays
// until it is put away.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const PLAN = {
    source: `bundle`,
    token: `tok-1`,
    name: `old-box`,
    items: [
        { id: `repo:site`, group: `repo`, label: `Repository site`, applicable: true, recommended: true, secrets: [] },
        { id: `skill:weather`, group: `skill`, label: `Skill, weather`, applicable: true, recommended: false, secrets: [] },
    ],
    carriesSecrets: false,
    refused: [],
    needsAction: [],
};
const REPORT = {
    applied: [{ id: `repo:site`, group: `repo`, label: `Repository site` }],
    failed: [{ id: `skill:weather`, label: `Skill, weather`, error: `the skill folder was empty` }],
    refused: [],
    needsAction: [],
};

const calls: { path: string; init?: RequestInit }[] = [];
// Answers the test holds back, by path, so a read or an apply can be left running while the panel comes and goes.
const held = new Map<string, Promise<unknown>>();
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({
    sandboxJson: (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        const answer = held.get(path);
        if (answer !== undefined) {
            return answer;
        }
        if (path === `/arrivals/hosts`) {
            return Promise.resolve({ hosts: [] });
        }
        if (path === `/arrivals/plan`) {
            return Promise.resolve(PLAN);
        }
        if (path === `/arrivals/apply`) {
            return Promise.resolve(REPORT);
        }
        return Promise.resolve({ ok: true });
    },
}));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: computed(() => ({ id: `s1`, name: `work` })), update: () => Promise.resolve() }),
}));

const { default: ArrivalPanel } = await import("./ArrivalPanel.vue");
const { forgetOperations } = await import("../../../workbench/operations/operations");

let app: App | undefined;
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};
const mount = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ArrivalPanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    await settle();
};
const unmount = (): void => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
};
const shown = (): string => document.body.textContent ?? ``;
const buttonStarting = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim().startsWith(label));
// The file input is hidden behind the Choose button; a change event on it is what a picked file looks like.
const pickFile = async (): Promise<void> => {
    const input = document.body.querySelector<HTMLInputElement>(`input[type="file"]`);
    if (input === null) {
        throw new Error(`no file input`);
    }
    Object.defineProperty(input, `files`, { configurable: true, value: [new File([`bundle`], `old-box.tgz`)] });
    input.dispatchEvent(new Event(`change`));
    await settle();
};

afterEach(() => {
    unmount();
    calls.length = 0;
    held.clear();
    forgetOperations();
});

it(`keeps reading a bundle across the panel closing, then shows its checklist when opened again`, async () => {
    let answer: (plan: unknown) => void = () => {};
    held.set(`/arrivals/plan`, new Promise((resolve) => (answer = resolve)));
    await mount();
    await pickFile();
    unmount();

    await mount();
    // Still reading: the button that would start a second upload is drawn waiting, and a second pick sends nothing.
    expect(buttonStarting(`Choose a file`)?.getAttribute(`data-p-disabled`)).toBe(`true`);
    await pickFile();
    expect(calls.filter((call) => call.path === `/arrivals/plan`)).toHaveLength(1);

    answer(PLAN);
    await settle();
    expect(shown()).toContain(`Repository site`);
    unmount();

    // Opened once more, the plan the daemon holds is still here to apply; nothing was uploaded twice.
    await mount();
    expect(shown()).toContain(`Repository site`);
    expect(calls.filter((call) => call.path === `/arrivals/plan`)).toHaveLength(1);
});

it(`applies the ticked rows and keeps the report until it is put away`, async () => {
    await mount();
    await pickFile();
    buttonStarting(`Bring in 1 item`)?.click();
    await settle();
    const sent = calls.find((call) => call.path === `/arrivals/apply`);
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ token: `tok-1`, items: [`repo:site`], includeSecrets: false });
    expect(shown()).toContain(`the skill folder was empty`);
    unmount();

    await mount();
    expect(shown()).toContain(`the skill folder was empty`);
    buttonStarting(`Dismiss`)?.click();
    await settle();
    expect(shown()).not.toContain(`the skill folder was empty`);
});
