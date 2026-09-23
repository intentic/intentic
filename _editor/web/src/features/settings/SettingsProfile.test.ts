// Needs jsdom: the profile row is a live-control affordance (hover camera overlay, inline rename) that a real DOM is
// needed to assert on.
import "@intentic/testing/dom";
import { vAction } from "@intentic/ui";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const user = ref<{ name: string; image: string | null } | undefined>({ name: `Artur Kurowski`, image: null });
const updateProfile = jest.fn<(input: { name?: string; image?: string }) => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`../auth/useAuth`, () => ({
    useAuth: () => ({ user, updateProfile }),
}));

const fileToSquareDataUrl = jest.fn<(file: File, fit: `cover` | `contain`) => Promise<string>>().mockResolvedValue(`data:image/webp;base64,NEW`);
jest.mock(`../../lib/imageDataUrl`, () => ({ fileToSquareDataUrl }));

// Plan chip words are pinned in hostedHours.test.ts; mocked here to avoid needing a query client.
const planBadge = ref<{ label: string; variant: string; detail: string } | undefined>(undefined);
jest.mock(`./hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ planBadge }) }));

const { default: SettingsProfile } = await import(`./SettingsProfile.vue`);

let app: App | undefined;

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SettingsProfile) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // The real directive, not a stub: v-action replaces @click, so a stub leaves every control inert.
    app.directive(`action`, vAction);
    app.mount(el);
    return el;
};

const avatarButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button[aria-label="Change avatar"]`)!;
const fileField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[type="file"]`)!;
// The name itself is the rename control (<InlineRename>, pinned in design-system/inlineRename.test.ts).
const nameButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`h2 button`)!;
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[aria-label="Display name"]`)!;

const pickFile = async (el: HTMLElement): Promise<void> => {
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `avatar.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
    user.value = { name: `Artur Kurowski`, image: null };
    planBadge.value = { label: `hosted`, variant: `primary`, detail: `Hosted plan, renews Oct 1.` };
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

// The row used to grow a hint line ("Enter saves · Esc cancels") the moment the pencil was pressed, which moved
// the plan chip and everything under it. Opening the rename may add nothing to this row.
it(`grows by nothing when the rename opens`, async () => {
    const el = mount();
    const lines = el.querySelectorAll(`p`).length;

    nameButton(el).click();
    await nextTick();

    expect(el.querySelectorAll(`p`).length).toBe(lines);
    expect(el.textContent).not.toContain(`Enter saves`);
});

it(`renames from the name's own field, without sending the avatar`, async () => {
    const el = mount();
    expect(nameButton(el).textContent).toBe(`Artur Kurowski, Rename display name`);
    nameButton(el).click();
    await nextTick();

    const field = nameField(el);
    expect(field.value).toBe(`Artur Kurowski`);
    field.value = `Artur K.`;
    field.dispatchEvent(new Event(`input`));
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ name: `Artur K.` }));
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

// The plan renders as a chip beside the name, never a link: Billing already has its own tab.
// Selected by the pill's shape, not its text, so the word assertion isn't circular.
// `ui-status-pill` is the badge's own geometry (utilities.css); `lowercase` is what tells it from any other pill.
const chip = (el: HTMLElement): HTMLElement | undefined =>
    [...el.querySelectorAll<HTMLElement>(`span.ui-status-pill`)].find((s) => s.className.includes(`lowercase`));

it(`states the plan beside the name, as a chip rather than a link`, () => {
    const el = mount();
    const badge = chip(el);
    expect(badge?.textContent?.trim()).toBe(`hosted`);
    expect(badge?.closest(`a`)).toBeNull();
    expect(badge?.closest(`button`)).toBeNull();
});

it(`shows the chip only while the platform sells a plan`, async () => {
    const el = mount();
    expect(chip(el)?.textContent?.trim()).toBe(`hosted`);

    // No plan sold answers `enabled: false`; there's no lane to name (hostedHours.ts).
    planBadge.value = undefined;
    await nextTick();
    expect(chip(el)).toBeUndefined();
});
