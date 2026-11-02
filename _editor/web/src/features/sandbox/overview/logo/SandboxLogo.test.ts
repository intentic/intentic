import "@intentic/testing/dom";
import { SandboxLogo } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";
import { logoStyleImage } from "./presets";

let app: App | undefined;

const drawn = async (image: string): Promise<string> => {
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(SandboxLogo, { image, size: 32 }) });
    app.component(`Icon`, IconStub);
    app.mount(root);
    await nextTick();
    return root.querySelector(`img`)!.getAttribute(`src`)!;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`drops the tinted square a stylized logo saved before it was removed still carries`, async () => {
    const current = logoStyleImage({ icon: `box`, color: `#2b8fd9` });
    const old = current.replace(
        encodeURIComponent(`data-intentic-logo="box:#2b8fd9">`),
        encodeURIComponent(`data-intentic-logo="box:#2b8fd9">\n        <rect width="64" height="64" rx="14" fill="#2b8fd9" fill-opacity=".14"/>`),
    );
    expect(old).not.toBe(current);
    expect(decodeURIComponent(await drawn(old))).not.toContain(`<rect`);
});

it(`leaves an uploaded image as it is`, async () => {
    const svg = `data:image/svg+xml,${encodeURIComponent(`<svg><rect width="64" height="64" rx="14" fill="#2b8fd9" fill-opacity=".14"/></svg>`)}`;
    expect(await drawn(svg)).toBe(svg);
});
