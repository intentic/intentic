// A new user created a project, found the tree showing only its README, took that for missing files and deleted the
// project: the chip in the status strip was the only sign the whole workspace had narrowed to it. The note then said so
// as a card above the rows in the link colour, which readers pressed by reflex; it is now one quiet line, no link colour.
import "@intentic/testing/dom";
import { type App, computed, createApp, h, nextTick, ref } from "vue";

const scope = ref(``);
jest.mock(`../../../../app/workspaceScope`, () => ({ workspaceDir: computed(() => scope.value) }));
const setProjectScope = jest.fn();
jest.mock(`../../../../app/projectScope`, () => ({ setProjectScope: (project: string | undefined) => setProjectScope(project) }));

const { default: WorkspaceScopeNote } = await import("../WorkspaceScopeNote.vue");

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

    expect(el.textContent).toContain(`cerberus only`);
    const button = el.querySelector(`button`);
    expect(button?.textContent?.trim()).toBe(`Show all`);
    button?.click();
    expect(setProjectScope).toHaveBeenCalledWith(undefined);
});

it(`does not dress the way out as a link`, async () => {
    scope.value = `cerberus`;
    const el = await mount();

    expect(el.querySelector(`button`)?.className).not.toContain(`text-link`);
});

it(`says nothing over the whole workspace`, async () => {
    const el = await mount();

    expect(el.textContent).toBe(``);
});
