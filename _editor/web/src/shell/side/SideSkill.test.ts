// A skill's page beside the section: what the page reports becomes what happens to its side tab. Typing keeps the look
// from being replaced by the next press, a file of its folder opens as a file tab beside it, a deletion closes it, and a
// new skill's tab becomes the saved skill's in its place on the strip.
import "@intentic/testing/dom";
import { type App, createApp, defineComponent, h } from "vue";

const keepTab = jest.fn();
const closeTabs = jest.fn();
const openBeside = jest.fn();
const revealSideView = jest.fn();

jest.mock(`../../workbench/side/sideTabs`, () => ({
    keepTab,
    closeTabs,
    openBeside,
    sideTabId: (view: string, input: Record<string, string>) => `${view}:${input[`skill`]}`,
}));
jest.mock(`../../workbench/side/sideViews`, () => ({ revealSideView }));
// The page itself is SkillPage's own test; this stands in for it with one button per thing it reports.
jest.mock(`../../features/sandbox/agent-settings/skills/SkillPage.vue`, () => ({
    default: defineComponent({
        emits: [`edited`, `open-file`, `saved`, `gone`],
        setup: (_, { emit }) => () =>
            h(`div`, [
                h(`button`, { id: `edit`, onClick: () => emit(`edited`) }),
                h(`button`, { id: `file`, onClick: () => emit(`open-file`, `.agents/skills/unsloppify/scripts/scan.sh`) }),
                h(`button`, { id: `save`, onClick: () => emit(`saved`, `changelog`) }),
                h(`button`, { id: `gone`, onClick: () => emit(`gone`) }),
            ]),
    }),
}));

const { default: SideSkill } = await import("./SideSkill.vue");

let app: App | undefined;

const mount = (skill: string, name: string): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(SideSkill, { input: { skill, name } }) });
    app.mount(host);
    return host;
};

const press = (host: HTMLElement, id: string): void => host.querySelector<HTMLElement>(`#${id}`)?.click();

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    for (const fn of [keepTab, closeTabs, openBeside, revealSideView]) {
        fn.mockClear();
    }
});

test(`typing into it keeps the look, so the next skill pressed opens beside it instead of over it`, () => {
    const host = mount(`notes`, `notes`);
    press(host, `edit`);
    expect(keepTab).toHaveBeenCalledWith(`skill:notes`);
});

test(`a file of its folder opens as a file tab beside it, and the skill's own tab stays`, () => {
    const host = mount(`unsloppify`, `unsloppify`);
    press(host, `file`);
    expect(keepTab).toHaveBeenCalledWith(`skill:unsloppify`);
    expect(revealSideView).toHaveBeenCalledWith(`file`, { path: `.agents/skills/unsloppify/scripts/scan.sh` });
});

test(`a new skill's tab becomes the saved skill's, in its place on the strip`, () => {
    const host = mount(`+new`, `New skill`);
    press(host, `save`);
    expect(openBeside).toHaveBeenCalledWith(`skill`, { skill: `changelog`, name: `changelog` }, { keep: true, replace: `skill:+new` });
});

test(`a deleted skill takes its tab with it`, () => {
    const host = mount(`scratch`, `scratch`);
    press(host, `gone`);
    expect(closeTabs).toHaveBeenCalledWith(new Set([`skill:scratch`]));
});
