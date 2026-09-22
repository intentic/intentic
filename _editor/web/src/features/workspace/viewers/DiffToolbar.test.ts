// The bar's settings moved behind one control, and the whole cost of that move is what the CLOSED control still
// says. Comments are hidden by default, so the diff under this bar is silently withholding lines; the old bar said
// so in a word, and these pin that the glyph says it now — and that the settings themselves are still there, one
// press away, for every shape of file the bar serves.
import "@intentic/testing/dom";
import { it, expect, afterEach, jest } from "bun:test";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Same reason as the other viewer suites: the import chain reads browser globals (useDevice's matchMedia,
// environment.ts's window.env), which the package preload stubs package-wide. Desktop, so Split|Unified is on offer.
const { default: DiffToolbar } = await import("./DiffToolbar.vue");
const { showComments, toggleShowComments } = (await import("../../../shell/window/useLayout")).useLayout();

let app: App | undefined;
const mount = async (path: string): Promise<HTMLElement> => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(DiffToolbar, { path }) });
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
    expect(panel()).toContain(`Changes`);
    expect(panel()).toContain(`Before / After`);
    expect(panel()).not.toContain(`Comments`);
    expect(panel()).not.toContain(`Layout`);
});
