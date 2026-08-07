// @vitest-environment jsdom
//
// jsdom because the subject is an AFFORDANCE. The logo used to be reachable only from inside name-edit mode — a
// tile that looked decorative until you pressed a button labelled "Edit" — so the properties worth pinning are
// all about what the tile offers before anything is typed: that an owner can reach it at rest, that a member
// cannot reach it at all, that picking a file is the whole save, and that a logo already set can be taken back
// off. None of those can be read off the code, and the first of them is the bug this file exists to prevent
// coming back.
import type { SandboxSummary } from "@intentic-app/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

// The sandbox singletons are the component's whole world (identity, reachability, the write), and the version
// card + update prompt below the header are separate surfaces with their own daemon calls — stubbed so this
// mounts the identity block and nothing else.
const active = ref<SandboxSummary | undefined>(undefined);
const update = vi.fn<(sandboxId: string, input: { name?: string; image?: string | null }) => Promise<void>>().mockResolvedValue(undefined);
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active, update, daemonUrl: ref(undefined), reachable: ref(true) }),
}));
vi.mock(`../../composables/sandbox/useSandboxVersion`, () => ({
    useSandboxVersion: () => ({ info: ref(undefined), installed: ref(undefined), latest: ref(undefined), updateAvailable: ref(false) }),
}));
vi.mock(`./SandboxUpdateCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SandboxBehindCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// The canvas downscale needs a real 2d context, which jsdom has not got. What matters here is not the pixels but
// WHICH fit was asked for: a logo has to be contained, because a centre crop of a wordmark loses the name.
const fileToSquareDataUrl = vi.fn<(file: File, fit: `cover` | `contain`) => Promise<string>>().mockResolvedValue(`data:image/webp;base64,NEW`);
vi.mock(`../../composables/imageDataUrl`, () => ({ fileToSquareDataUrl }));

const { default: SandboxOverview } = await import("./SandboxOverview.vue");

const sandboxRow = (overrides: Partial<SandboxSummary> = {}): SandboxSummary =>
    ({
        id: `s1`,
        name: `radarsu-intentic`,
        image: null,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        token: `tok`,
        role: `owner`,
        providedTunnel: false,
        ...overrides,
    }) as SandboxSummary;

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin. Icon
// prints the glyph it was handed, because WHICH glyph reports the save in flight.
const mount = (sandbox: SandboxSummary): HTMLElement => {
    active.value = sandbox;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxOverview) });
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
    app.mount(el);
    return el;
};

const logoTile = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button[aria-label$="logo"]`)!;
const anyLogoTile = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`button`)!;
const fileField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[type="file"]`)!;

// The pick arrives as a change event on a file input, which jsdom will not let a test assign `files` on.
const pickFile = async (el: HTMLElement): Promise<void> => {
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `logo.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
};

beforeEach(() => {
    update.mockClear();
    fileToSquareDataUrl.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The regression this file is named for: at rest, with nothing typed and no mode entered, the tile is a control.
it(`offers the logo to an owner at rest, with no edit mode to enter first`, () => {
    const tile = logoTile(mount(sandboxRow()));
    expect(tile.disabled).toBe(false);
    expect(tile.getAttribute(`aria-label`)).toBe(`Add a logo`);
});

// An empty tile has exactly one thing to do, so pressing it does it. Charging a menu for the first-run case —
// the case in front of every new sandbox — is the cost this asymmetry exists to avoid.
it(`goes straight to the file dialog when there is no logo yet`, () => {
    const el = mount(sandboxRow());
    const opened = vi.spyOn(fileField(el), `click`);
    logoTile(el).click();
    expect(opened).toHaveBeenCalled();
    expect([...document.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Remove logo`))).toBe(false);
});

it(`says the tile does two things once a logo is set, and one thing before that`, () => {
    expect(logoTile(mount(sandboxRow())).getAttribute(`aria-label`)).toBe(`Add a logo`);
    app?.unmount();
    document.body.innerHTML = ``;
    expect(logoTile(mount(sandboxRow({ image: `data:image/webp;base64,OLD` }))).getAttribute(`aria-label`)).toBe(`Change or remove the logo`);
});

// A member sees the identity block but cannot change it, and the tile has to say so by being unreachable rather
// than by failing on press — including for a keyboard, which is what `disabled` buys that a no-op handler does not.
it(`keeps a member out of the tile entirely`, () => {
    const tile = anyLogoTile(mount(sandboxRow({ role: `collaborator` })));
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute(`aria-label`)).toBeNull();
});

// The whole save: one file, contained, written straight through. Nothing staged, no second press.
it(`saves the picked file on its own, fitted rather than cropped`, async () => {
    const el = mount(sandboxRow());
    await pickFile(el);
    expect(fileToSquareDataUrl).toHaveBeenCalledWith(expect.any(File), `contain`);
    expect(update).toHaveBeenCalledWith(`s1`, { image: `data:image/webp;base64,NEW` });
});

// A rename must not ride along with a logo, and a logo must not ride along with a rename — the two controls are
// independent now, so each sends only its own field.
it(`sends the logo without the name`, async () => {
    const el = mount(sandboxRow());
    await pickFile(el);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty(`name`);
});

// The way back to the monogram. `null` rather than an omitted field is the whole point: an absent `image` means
// "leave it alone" all the way down to the row.
it(`takes a logo back off with an explicit null`, async () => {
    const el = mount(sandboxRow({ image: `data:image/webp;base64,OLD` }));
    const removeRow = (): HTMLButtonElement | undefined =>
        [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(`Remove logo`));
    // Behind the press, not sitting in the DOM waiting — otherwise the assertion below would hold with the menu
    // never opening at all.
    expect(removeRow()).toBeUndefined();
    logoTile(el).click();
    const remove = await vi.waitFor(() => {
        const button = removeRow();
        expect(button).toBeDefined();
        return button!;
    });
    remove.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`s1`, { image: null }));
});

// An unreadable file is the FILE's fault, and it has to be reported as that rather than as a failed save — and
// it must not reach the platform at all.
it(`reports an unreadable file without writing anything`, async () => {
    fileToSquareDataUrl.mockRejectedValueOnce(new Error(`nope`));
    const el = mount(sandboxRow());
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `logo.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await vi.waitFor(() => expect(el.textContent).toContain(`Couldn't read that file as an image.`));
    expect(update).not.toHaveBeenCalled();
});
