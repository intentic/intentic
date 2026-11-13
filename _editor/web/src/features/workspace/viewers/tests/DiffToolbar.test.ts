// The bar's settings moved behind one control, and the whole cost of that move is what the CLOSED control still
// says. Comments are hidden by default, so the diff under this bar is silently withholding lines; the old bar said
// so in a word, and these pin that the glyph says it now — and that the settings themselves are still there, one
// press away, for every shape of file the bar serves.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Same reason as the other viewer suites: the import chain reads browser globals (useDevice's matchMedia,
// environment.ts's window.env), which the package preload stubs package-wide. Desktop, so Split|Unified is on offer.
const { default: DiffToolbar } = await import("../DiffToolbar.vue");
const { showComments, toggleShowComments } = (await import("../../../../workbench/window/useLayout")).useLayout();

let app: App | undefined;
const mount = async (path: string, file?: string): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(DiffToolbar, { path, file }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    await nextTick();
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    // The preference outlives a mount, so one test must not hand the next a different bar.
    if (showComments.value) {
        toggleShowComments();
    }
    jest.restoreAllMocks();
});

const control = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`[aria-expanded]`)!;
// The panel teleports out of the bar on desktop, so it is looked for in the document, not in the mounted element.
const panel = (): string => document.body.textContent ?? ``;

it(`keeps saying that comments are being withheld while the settings are closed`, async () => {
    const el = await mount(`src/db/schema.ts`);

    // Hidden is the default for a diff, and the reader is never told in words any more — so the glyph has to carry it.
    expect(showComments.value).toBe(false);
    expect(control(el).querySelector(`[data-icon="eye-slash"]`)).not.toBeNull();
    expect(control(el).getAttribute(`aria-expanded`)).toBe(`false`);

    toggleShowComments();
    await nextTick();
    expect(control(el).querySelector(`[data-icon="eye"]`)).not.toBeNull();
    expect(control(el).querySelector(`[data-icon="eye-slash"]`)).toBeNull();
});

it(`opens the whole reading of a code file on one press`, async () => {
    const el = await mount(`src/db/schema.ts`);
    expect(panel()).not.toContain(`Layout`);

    control(el).click();
    await nextTick();

    // Both sticky preferences, each stating the side it is not on, so neither is a switch whose off-state is a guess.
    expect(panel()).toContain(`Layout`);
    expect(panel()).toContain(`Split`);
    expect(panel()).toContain(`Unified`);
    expect(panel()).toContain(`Comments`);
    expect(panel()).toContain(`Shown`);
    expect(panel()).toContain(`Hidden`);
    expect(control(el).getAttribute(`aria-expanded`)).toBe(`true`);
});

// A document has no comments to hide and no line layout to choose: what it has instead is which of its readings to
// draw. The control must therefore stop claiming a state it does not have, and offer the one it does.
it(`offers a document its readings, and drops the settings that cannot apply to it`, async () => {
    const el = await mount(`docs/handover.docx`);
    expect(control(el).querySelector(`[data-icon="sliders-h"]`)).not.toBeNull();
    expect(control(el).querySelector(`[data-icon="eye-slash"]`)).toBeNull();

    control(el).click();
    await nextTick();

    expect(panel()).toContain(`Reading`);
    expect(panel()).toContain(`Text`);
    expect(panel()).toContain(`Before / After`);
    expect(panel()).not.toContain(`Comments`);
    expect(panel()).not.toContain(`Layout`);
});

// The reading is what a document is opened with, so it sits in the bar itself (the popover keeps it only for a bar too
// narrow to hold it); a reader who pressed Before / After once must see the way back without opening anything.
it(`shows a document's readings in the bar itself, closed`, async () => {
    const el = await mount(`docs/handover.pdf`);
    const pills = [...el.querySelectorAll(`button`)].map((button) => button.textContent?.trim());
    expect(pills).toContain(`Text`);
    expect(pills).toContain(`Before / After`);
    expect(control(el).getAttribute(`aria-expanded`)).toBe(`false`);
});

// A staged row is labelled "a.pdf (staged)": the label's suffix once hid that the file is a document, which left the
// bar with no reading switch at all, and a reader who had chosen Before / After with no way back to the text.
it(`reads the format from the file, not from a label carrying a suffix`, async () => {
    const el = await mount(`demo/01_kadry/Regulamin.pdf (staged)`, `demo/01_kadry/Regulamin.pdf`);
    expect(el.textContent).toContain(`Regulamin.pdf (staged)`);
    expect([...el.querySelectorAll(`button`)].map((button) => button.textContent?.trim())).toContain(`Before / After`);
    expect(control(el).querySelector(`[data-icon="eye-slash"]`)).toBeNull();
});
