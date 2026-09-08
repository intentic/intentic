// @vitest-environment jsdom
// Offers the desktop app install as an alternative to the terminal command; makes no sense inside the desktop
// app itself. What the panel explains (the command, its removal line) is the same in both windows.
import { expect, it, vi } from "vitest";
import { createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";

// useDevice reads matchMedia at module scope; environment.ts throws without window.env.

// The one fact that decides this: whether the app has marked this webview as its own.
const version = { value: undefined as string | undefined };
vi.mock(`../../app/environments/desktop`, () => ({
    DESKTOP_DOWNLOADS: { windows: `https://intentic.dev/desktop/windows`, linuxAppImage: `https://intentic.dev/desktop/linux` },
    desktopVersion: () => version.value,
}));

const { default: SetupRunDetails } = await import("./SetupRunDetails.vue");

const render = (): string => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SetupRunDetails, { cleanup: `curl -fsSL https://intentic.dev/cleanup.sh | sh` }) });
    app.component(`Icon`, IconStub);
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
    expect(text).toContain(`Starts your sandbox in`);
    expect(text).toContain(`Removes all of it`);
});
