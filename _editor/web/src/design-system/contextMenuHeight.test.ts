import "@intentic/testing/dom";
import { ContextMenu } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import PrimeVue from "primevue/config";
import { it, expect, afterEach } from "bun:test";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// A menu is only as tall as the screen has room for: PrimeVue flips the whole box and then clamps it to the top, so
// an uncapped model longer than the viewport (the workspace scope chip lists every conversation in the fleet) runs
// off the bottom edge with its last rows unreachable. The cap has to be on the list, which scrolls, not on the model.

const model: MenuItem[] = Array.from({ length: 60 }, (_, index) => ({ label: `Conversation ${index}` }));

let app: ReturnType<typeof createApp> | undefined;

const openAt = async (clientY: number): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const menu = ref<{ show: (event: Event) => void } | undefined>();
    app = createApp(defineComponent({ setup: () => () => h(ContextMenu, { ref: menu, model }) }));
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(host);
    menu.value?.show(new MouseEvent(`click`, { bubbles: true, clientY }));
    await nextTick();
    await nextTick();
    return document.querySelector<HTMLElement>(`.p-contextmenu-root-list`)!;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps a menu opened near the top inside the room below it`, async () => {
    const list = await openAt(40);
    // window.innerHeight is jsdom's 768: 768 - 40 below the click, less the edge gap.
    expect(list.style.maxHeight).toBe(`720px`);
    // The cap only hides rows unless the list itself scrolls.
    expect(list.classList.contains(`overflow-y-auto`)).toBe(true);
});

it(`keeps a menu opened near the bottom inside the room above it, where PrimeVue flips it`, async () => {
    const list = await openAt(700);
    expect(list.style.maxHeight).toBe(`692px`);
});

it(`gives a menu with no pointer position the whole viewport`, async () => {
    const list = await openAt(0);
    expect(list.style.maxHeight).toBe(`760px`);
});
