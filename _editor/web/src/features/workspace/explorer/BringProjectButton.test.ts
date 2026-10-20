import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { createApp, h, nextTick } from "vue";
import BringProjectButton from "./BringProjectButton.vue";
import { useBringProject } from "./useBringProject";

const mount = () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(BringProjectButton, { look: `home` }) });
    app.directive(`tooltip`, {});
    app.mount(el);
    const button = el.querySelector(`button`);
    if (button === null) {
        throw new Error(`The home must offer a project button`);
    }
    return { button, unmount: () => { app.unmount(); el.remove(); } };
};

beforeEach(() => {
    jest.useFakeTimers();
    window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `test`, update: null };
    useBringProject().open.value = false;
});

afterEach(() => {
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    delete window.__INTENTIC_LOCAL__;
    delete window.__INTENTIC_DESKTOP__;
    unstubAllGlobals();
});

test(`a local folder's home asks the desktop app for its native folder picker`, async () => {
    window.__INTENTIC_LOCAL__ = { daemonUrl: `http://127.0.0.1:1`, token: `test`, id: `folder`, name: `project`, path: `/projects/app` };
    const location = { href: `` };
    stubGlobal(`location`, location);
    const { button, unmount } = mount();
    expect(button.textContent).toContain(`Open a folder…`);
    button.click();
    // The desktop link queue waits for load when the test DOM is still loading.
    window.dispatchEvent(new Event(`load`));
    await nextTick();
    expect(location.href).toBe(`intentic://local?do=open-folder`);
    expect(useBringProject().open.value).toBe(false);
    unmount();
});

test(`a sandbox's home in the desktop app opens the shared import dialog`, async () => {
    const { button, unmount } = mount();
    expect(button.textContent).toContain(`Bring a project in`);
    button.click();
    await nextTick();
    expect(useBringProject().open.value).toBe(true);
    unmount();
});
