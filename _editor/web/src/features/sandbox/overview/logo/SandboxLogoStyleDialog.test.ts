import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import SandboxLogoStyleDialog from "./SandboxLogoStyleDialog.vue";
import { logoStyleImage, readLogoStyle } from "./presets";

let app: App | undefined;
const write = jest.fn<(image: string) => Promise<void>>();
const closed = jest.fn<() => void>();
const savedImage = logoStyleImage({ icon: `moon`, color: `#e07400` });

const mount = async (image: string | null = savedImage): Promise<void> => {
    const root = document.createElement(`div`);
    document.body.append(root);
    app = createApp({ render: () => h(SandboxLogoStyleDialog, { image, name: `My sandbox`, write, onClose: closed }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(root);
    await nextTick();
};
const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find(
        (candidate) => candidate.getAttribute(`aria-label`) === label || candidate.textContent?.trim() === label,
    )!;
const preview = (): HTMLImageElement => document.querySelector<HTMLImageElement>(`[aria-label="Logo preview"] img`)!;

beforeEach(() => {
    write.mockReset().mockResolvedValue(undefined);
    closed.mockClear();
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`restores saved choices and keeps the matching preview when reopened`, async () => {
    await mount();
    expect(button(`Moon`).getAttribute(`aria-pressed`)).toBe(`true`);
    expect(button(`Ember`).getAttribute(`aria-checked`)).toBe(`true`);
    expect(preview().getAttribute(`src`)).toBe(savedImage);
    expect(button(`Save`).disabled).toBe(true);
});

it(`previews both choices before saving the exact image being previewed`, async () => {
    await mount();
    button(`Flask`).click();
    button(`Azure`).click();
    await nextTick();
    const image = preview().getAttribute(`src`)!;
    expect(readLogoStyle(image)?.icon).toBe(`flask`);
    const ink = document.createElement(`span`);
    ink.style.color = readLogoStyle(image)!.color;
    expect(ink.style.color).toBe(button(`Azure`).style.backgroundColor);
    expect(button(`Azure`).getAttribute(`aria-checked`)).toBe(`true`);
    expect(button(`Ember`).getAttribute(`aria-checked`)).toBe(`false`);
    expect(button(`Flask`).getAttribute(`aria-pressed`)).toBe(`true`);
    expect(button(`Moon`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(image).not.toBe(savedImage);
    expect(write).not.toHaveBeenCalled();
    button(`Save`).click();
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(image);
});

it(`cancels a draft without replacing an uploaded image`, async () => {
    await mount(`data:image/webp;base64,CUSTOM`);
    button(`Star`).click();
    await nextTick();
    button(`Cancel`).click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
});

it(`keeps the draft and the dialog open after a failed save, allowing a retry`, async () => {
    write.mockRejectedValueOnce(new Error(`Please try again.`));
    await mount();
    button(`Robot`).click();
    await nextTick();
    const image = preview().getAttribute(`src`);
    button(`Save`).click();
    await waitFor(() => expect(document.querySelector(`[role="alert"]`)?.textContent).toBe(`Please try again.`));
    expect(closed).not.toHaveBeenCalled();
    expect(preview().getAttribute(`src`)).toBe(image);
    expect(button(`Save`).disabled).toBe(false);
    button(`Save`).click();
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(image);
});
