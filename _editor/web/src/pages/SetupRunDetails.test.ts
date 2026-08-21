// @vitest-environment jsdom
//
// WHO THIS PANEL IS OFFERING THE DESKTOP APP TO. It sits beside the install command as the alternative to a
// terminal, which is exactly right in a browser, and nonsense in the app itself, where the reader is already
// inside the thing the two buttons download. What this panel EXPLAINS (what the command does, and the one line
// that removes it again) is the same in both windows; only the offer to install it is not.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";

// The import-time globals a mounted view needs (see Setup.test.ts): ui's useDevice reads matchMedia at module
// scope, environment.ts reads window.env and throws without it.

// The one fact that decides this: whether the app has marked this webview as its own.
const version = { value: undefined as string | undefined };
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_DOWNLOADS: { windows: `https://intentic.dev/desktop/windows`, linuxAppImage: `https://intentic.dev/desktop/linux` },
    desktopVersion: () => version.value,
}));

const { default: SetupRunDetails } = await import("./SetupRunDetails.vue");

const render = (): string => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SetupRunDetails, { cleanup: `curl -fsSL https://intentic.dev/cleanup.sh | sh` }) });
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    const text = el.textContent ?? ``;
    app.unmount();
    el.remove();
    return text;
};

it(`offers the installers in a browser`, () => {
    version.value = undefined;
    const text = render();
    expect(text).toContain(`Or use the desktop app`);
    expect(text).toContain(`Windows`);
    expect(text).toContain(`Linux`);
});

it(`offers no installers inside the desktop app, and explains the same command`, () => {
    version.value = `1.2.3`;
    const text = render();
    expect(text).not.toContain(`Or use the desktop app`);
    expect(text).not.toContain(`Windows`);
    // Everything this panel is actually for survives the removal.
    expect(text).toContain(`Starts your sandbox in`);
    expect(text).toContain(`Removes all of it`);
});
