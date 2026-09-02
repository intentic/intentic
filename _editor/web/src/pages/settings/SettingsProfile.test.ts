// @vitest-environment jsdom
//
// jsdom because the subject is an AFFORDANCE. The profile row is one identity strip: the avatar is a live
// control at rest (camera overlay on hover), and rename is a compact pencil attached to the name rather than
// a separate form with a Save row.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const user = ref<{ name: string; image: string | null } | undefined>({ name: `Artur Kurowski`, image: null });
const updateProfile = vi.fn<(input: { name?: string; image?: string }) => Promise<void>>().mockResolvedValue(undefined);
vi.mock(`../../composables/useAuth`, () => ({
    useAuth: () => ({ user, updateProfile }),
}));

const fileToSquareDataUrl = vi.fn<(file: File, fit: `cover` | `contain`) => Promise<string>>().mockResolvedValue(`data:image/webp;base64,NEW`);
vi.mock(`../../composables/imageDataUrl`, () => ({ fileToSquareDataUrl }));

const { default: SettingsProfile } = await import(`./SettingsProfile.vue`);

let app: App | undefined;

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SettingsProfile) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.directive(`action`, {});
    app.mount(el);
    return el;
};

const avatarButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button[aria-label="Change avatar"]`)!;
const fileField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[type="file"]`)!;
const renameButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button[aria-label="Rename display name"]`)!;
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[aria-label="Display name"]`)!;
const saveNameButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button[aria-label="Save display name"]`)!;

const pickFile = async (el: HTMLElement): Promise<void> => {
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `avatar.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await vi.waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
    user.value = { name: `Artur Kurowski`, image: null };
    updateProfile.mockClear();
    fileToSquareDataUrl.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the avatar as a live control with no separate change button`, () => {
    const el = mount();
    expect(avatarButton(el).disabled).toBe(false);
    expect(el.textContent).not.toContain(`Change avatar`);
    expect(avatarButton(el).querySelector(`[data-icon="camera"]`)).not.toBeNull();
});

it(`keeps rename controls compact and attached to the name`, async () => {
    const el = mount();
    const rename = renameButton(el);
    expect(rename.textContent).toBe(``);
    expect(rename.querySelector(`[data-icon="pencil"]`)).not.toBeNull();

    rename.click();
    await nextTick();

    expect(nameField(el).value).toBe(`Artur Kurowski`);
    expect(saveNameButton(el).textContent).toBe(``);
    expect(saveNameButton(el).querySelector(`[data-icon="check"]`)).not.toBeNull();
    expect(el.querySelector(`button[aria-label="Cancel rename"] [data-icon="times"]`)).not.toBeNull();
});

it(`renames from the inline field without sending the avatar`, async () => {
    const el = mount();
    renameButton(el).click();
    await nextTick();

    const field = nameField(el);
    field.value = `Artur K.`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    saveNameButton(el).click();

    await vi.waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ name: `Artur K.` }));
    expect(updateProfile.mock.calls[0]?.[0]).not.toHaveProperty(`image`);
});

it(`saves the picked avatar immediately, without a form Save step`, async () => {
    const el = mount();
    await pickFile(el);
    expect(fileToSquareDataUrl).toHaveBeenCalledWith(expect.any(File), `cover`);
    expect(updateProfile).toHaveBeenCalledWith({ image: `data:image/webp;base64,NEW` });
});

it(`sends the avatar without the name`, async () => {
    const el = mount();
    await pickFile(el);
    expect(updateProfile.mock.calls[0]?.[0]).not.toHaveProperty(`name`);
});
