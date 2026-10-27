// A closed need reads as one line of what it ended as, not the four sentences it used to stack: the settings a change
// moved in its form's words, a teammate's face and their word back, and the agent not having heard yet. What restates
// the title and its chip (the daemon's "now has the change applied", "the agent was told", "answered by" the reader) is
// not drawn, and the agent's case is one press away.
import "@intentic/testing/dom";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";

jest.mock(`../../client/session/sandboxSession`, () => ({ useSandboxSession: () => ({ presentedEmail: ref(`me@acme.dev`) }) }));
// A Windows PC whose tile's extension is off: its switches still read in their words, from the fields every device carries.
jest.mock(`../../models/capabilities/useCapabilities`, () => ({
    useCapabilities: () => ({ capabilities: ref([{ id: `omen`, kind: `device`, status: { state: `active` }, config: {}, secrets: [] }]) }),
}));
jest.mock(`../../models/extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: ref([]) }) }));

const { default: NeedOutcome } = await import("./NeedOutcome.vue");

const CHANGE: Need = {
    id: `need-1`,
    conversationId: `c-1`,
    subject: { kind: `capability`, entry: `windows`, name: `Windows PC`, mode: `change`, instance: `omen`, changes: { control: `on` } },
    title: `Change Windows PC ("omen")`,
    why: `Read the runner's diagnostic logs.`,
    status: `met`,
    outcome: `Windows PC "omen" now has the change applied.`,
    told: `turn`,
    answeredBy: `me@acme.dev`,
    createdAt: 1,
    updatedAt: 2,
};

let app: App | undefined;
const mount = (need: Need): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(NeedOutcome, { need }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says what a change moved, in the form's words, and nothing the chip already says`, () => {
    const element = mount(CHANGE);
    const change = element.querySelector(`[data-setting-change]`);
    expect([...(change?.children ?? [])].map((part) => part.textContent)).toEqual([`Use the mouse and keyboard`, `Allowed`]);
    expect(element.textContent).not.toContain(`now has the change applied`);
    expect(element.textContent).not.toContain(`told`);
    expect(element.querySelector(`[data-card-person]`)).toBeNull();
});

it(`keeps the agent's case one press away`, async () => {
    const element = mount(CHANGE);
    expect(element.querySelector(`[data-agent-case]`)).toBeNull();
    const toggle = element.querySelector<HTMLButtonElement>(`[data-card-outcome-toggle]`);
    expect(toggle?.textContent?.trim()).toBe(`Why it asked`);
    toggle?.click();
    await nextTick();
    expect(element.querySelector(`[data-agent-case]`)?.textContent).toContain(`Read the runner's diagnostic logs.`);
    expect(toggle?.getAttribute(`aria-expanded`)).toBe(`true`);
});

it(`quotes a teammate's word back under their face, without the lead-in written for the agent`, () => {
    const element = mount({
        ...CHANGE,
        status: `declined`,
        outcome: `They said: use the gif the docs build already makes`,
        answeredBy: `grace@acme.dev`,
    });
    expect(element.querySelector(`[data-card-person]`)?.textContent).toContain(`grace@acme.dev`);
    expect(element.querySelector(`[data-need-note]`)?.textContent).toBe(`use the gif the docs build already makes`);
    expect(element.textContent).not.toContain(`They said`);
});

it(`says when the agent has not heard yet`, () => {
    const { told: _told, ...untold } = CHANGE;
    const element = mount(untold);
    expect(element.querySelector(`[data-need-unheard]`)?.textContent).toContain(`The agent has not been told yet`);
});

it(`draws nothing under a plain yes with no case to fold`, () => {
    const { why: _why, ...bare } = CHANGE;
    const element = mount({ ...bare, subject: { kind: `secret`, name: `NPM_TOKEN` }, outcome: `NPM_TOKEN is stored.` });
    expect(element.querySelector(`[data-card-outcome]`)).toBeNull();
});
