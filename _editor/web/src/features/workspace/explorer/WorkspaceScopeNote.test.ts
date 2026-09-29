// A new user created a project, found the tree showing only its README, took that for missing files and deleted the
// project: the chip in the status strip was the only sign the whole workspace had narrowed to it.
import "@intentic/testing/dom";
import { type App, computed, createApp, h, nextTick, ref } from "vue";

const scope = ref(``);
jest.mock(`../health/workspaceScope`, () => ({ workspaceDir: computed(() => scope.value) }));
const setProjectScope = jest.fn();
jest.mock(`../../../app/projectScope`, () => ({ setProjectScope: (project: string | undefined) => setProjectScope(project) }));

const { default: WorkspaceScopeNote } = await import("./WorkspaceScopeNote.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(WorkspaceScopeNote) });
    app.mount(el);
    await nextTick();
    return el;
};

afterEach(() => {
    scope.value = ``;
    setProjectScope.mockReset();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`says the tree shows one project only, and lifts it on a press`, async () => {
    scope.value = `cerberus`;
    const el = await mount();

    expect(el.textContent).toContain(`Showing cerberus only: its files, agents and checks.`);
    el.querySelector(`button`)?.click();
    expect(setProjectScope).toHaveBeenCalledWith(undefined);
});

it(`says nothing over the whole workspace`, async () => {
    const el = await mount();

    expect(el.textContent).toBe(``);
});
