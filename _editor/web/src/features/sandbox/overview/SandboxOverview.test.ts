// @vitest-environment jsdom
// Pins that the logo tile is live at rest (not behind rename mode) and rename stays compact and independent.
// jsdom: mounts the component tree and reads rendered DOM.
import type { SandboxSummary } from "@intentic/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Stubs the sandbox's other surfaces (version, workspace tree, availability) so only the identity block mounts.
const active = ref<SandboxSummary | undefined>(undefined);
const update = vi.fn<(sandboxId: string, input: { name?: string; image?: string | null }) => Promise<void>>().mockResolvedValue(undefined);
vi.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({ active, update, daemonUrl: ref(undefined), reachable: ref(true) }),
}));
vi.mock(`./useSandboxVersion`, () => ({
    useSandboxVersion: () => ({ info: ref(undefined), installed: ref(undefined), latest: ref(undefined), updateAvailable: ref(false) }),
}));
vi.mock(`../../workspace/explorer/useWorkspaceTree`, () => ({ useWorkspaceTree: () => ({ hasSnapshot: ref(true) }) }));
const availability = ref<`live` | `warming` | `busy`>(`live`);
vi.mock(`./useSandboxAvailability`, () => ({ useSandboxAvailability: () => availability }));
// Where the sandbox runs is read off the fleet and the transport; stubbed for the same reason as the rest, so this
// suite mounts the identity block alone rather than the devices query behind it.
const placement = ref<{ kind: string; icon: string; label: string; detail: string } | undefined>(undefined);
vi.mock(`./useSandboxPlacement`, () => ({ useSandboxPlacement: () => placement }));
// Hosted plan standing is a plain ref here, not a query; the sentence itself lives in hostedHours.ts.
const machineStanding = ref<string | undefined>(undefined);
const planOffered = ref(false);
vi.mock(`../../settings/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ machineStanding, offered: planOffered }) }));
vi.mock(`./SandboxUpdateCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SandboxBehindCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./manifest/SandboxManifestCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// jsdom has no 2d canvas context; stubs the resize and asserts only which fit (`contain`) was requested.
const fileToSquareDataUrl = vi.fn<(file: File, fit: `cover` | `contain`) => Promise<string>>().mockResolvedValue(`data:image/webp;base64,NEW`);
vi.mock(`../../../lib/imageDataUrl`, () => ({ fileToSquareDataUrl }));

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
        providedAddress: false,
        ...overrides,
    }) as SandboxSummary;

let app: App | undefined;
// Icon and v-tooltip are installed app-wide; stand-ins isolate this test from the rest of the UI plugin.
const mount = (sandbox: SandboxSummary): HTMLElement => {
    active.value = sandbox;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxOverview) });
    app.component(`Icon`, IconStub);
    // RouterLink stub renders an anchor so the hosted upgrade card doesn't warn about a missing router.
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: { type: String, default: `` } },
            render() {
                return h(`a`, { href: this.to }, this.$slots[`default`]?.());
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
// The title itself is the rename control (<InlineRename>, pinned in design-system/inlineRename.test.ts); the
// heading it sits in is this card's own decision.
const titleButton = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>(`h2 button`)!;
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[aria-label="Sandbox name"]`)!;

// jsdom won't let a test assign `files` directly; this defines the property to simulate a picked file.
const pickFile = async (el: HTMLElement): Promise<void> => {
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `logo.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
    availability.value = `live`;
    update.mockClear();
    fileToSquareDataUrl.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`does not badge the happy path as online`, () => {
    expect(mount(sandboxRow()).textContent).not.toContain(`Online`);
});

it(`badges a sandbox that is still warming`, async () => {
    availability.value = `warming`;
    const root = mount(sandboxRow());
    await nextTick();
    expect(root.textContent).toMatch(/starting/i);
});

it(`offers the logo to an owner at rest, with no edit mode to enter first`, () => {
    const tile = logoTile(mount(sandboxRow()));
    expect(tile.disabled).toBe(false);
    expect(tile.getAttribute(`aria-label`)).toBe(`Add a logo`);
});

// The complaint this card was rebuilt for: entering the rename used to add a hint line under the title, so the
// card grew by a line the moment you pressed the pencil. Nothing under the title may appear because of a mode.
it(`grows by nothing when the rename opens`, async () => {
    const el = mount(sandboxRow());
    const lines = el.querySelectorAll(`p`).length;

    titleButton(el).click();
    await nextTick();

    expect(el.querySelectorAll(`p`).length).toBe(lines);
    expect(el.textContent).not.toContain(`Enter saves`);
});

it(`renames from the title's own field, without sending the logo`, async () => {
    const el = mount(sandboxRow());
    expect(titleButton(el).textContent).toBe(`radarsu-intentic, Rename sandbox`);
    titleButton(el).click();
    await nextTick();

    const field = nameField(el);
    expect(field.value).toBe(`radarsu-intentic`);
    field.value = `workbench`;
    field.dispatchEvent(new Event(`input`));
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));

    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`s1`, { name: `workbench` }));
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty(`image`);
});

// Same rule as the logo tile beside it: a member is kept out of the control, not handed a dead one.
it(`gives a member the name as text, with nothing to press`, () => {
    const el = mount(sandboxRow({ role: `collaborator` }));
    expect(titleButton(el)).toBeNull();
    // The clipping span, not the heading: the heading also holds the invisible twin that measures the box.
    expect(el.querySelector(`h2 span.truncate`)?.textContent).toBe(`radarsu-intentic`);
});

it(`goes straight to the file dialog when there is no logo yet`, () => {
    const el = mount(sandboxRow());
    const opened = vi.spyOn(fileField(el), `click`);
    logoTile(el).click();
    expect(opened).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Remove logo`))).toBe(false);
});

it(`says the tile does two things once a logo is set, and one thing before that`, () => {
    expect(logoTile(mount(sandboxRow())).getAttribute(`aria-label`)).toBe(`Add a logo`);
    app?.unmount();
    document.body.innerHTML = ``;
    expect(logoTile(mount(sandboxRow({ image: `data:image/webp;base64,OLD` }))).getAttribute(`aria-label`)).toBe(`Change or remove the logo`);
});

// Disabled, not a no-op handler, so a keyboard user is also kept out.
it(`keeps a member out of the tile entirely`, () => {
    const tile = anyLogoTile(mount(sandboxRow({ role: `collaborator` })));
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute(`aria-label`)).toBeNull();
});

it(`saves the picked file on its own, fitted rather than cropped`, async () => {
    const el = mount(sandboxRow());
    await pickFile(el);
    expect(fileToSquareDataUrl).toHaveBeenCalledWith(expect.any(File), `contain`);
    expect(update).toHaveBeenCalledWith(`s1`, { image: `data:image/webp;base64,NEW` });
});

it(`sends the logo without the name`, async () => {
    const el = mount(sandboxRow());
    await pickFile(el);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty(`name`);
});

// Explicit `null` clears the logo; an omitted `image` field means leave it alone, all the way to the row.
it(`takes a logo back off with an explicit null`, async () => {
    const el = mount(sandboxRow({ image: `data:image/webp;base64,OLD` }));
    const removeRow = (): HTMLButtonElement | undefined =>
        [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(`Remove logo`));
    // Menu renders only once opened, so this checks it isn't in the DOM yet, not merely hidden.
    expect(removeRow()).toBeUndefined();
    // AnchoredOverlay closes itself if its anchor measures 0x0, which is everything in jsdom by default; this stub
    // gives it real dimensions.
    const tile = logoTile(el);
    tile.getBoundingClientRect = () =>
        ({ top: 120, left: 40, width: 48, height: 48, right: 88, bottom: 168, x: 40, y: 120, toJSON: () => ({}) }) as DOMRect;
    tile.click();
    const remove = await vi.waitFor(() => {
        const button = removeRow();
        expect(button).toEqual(expect.any(Object));
        return button!;
    });
    remove.click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`s1`, { image: null }));
});

it(`reports an unreadable file without writing anything`, async () => {
    fileToSquareDataUrl.mockRejectedValueOnce(new Error(`nope`));
    const el = mount(sandboxRow());
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `logo.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await vi.waitFor(() => expect(el.textContent).toContain(`Couldn't read that file as an image.`));
    expect(update).not.toHaveBeenCalled();
});

it(`states the machine's standing on the hosted card, with Billing where a plan is sold`, async () => {
    machineStanding.value = `12 h of 40 h left this month`;
    planOffered.value = true;
    const root = mount(sandboxRow({ role: `owner`, hosted: { region: `arn`, warm: true } }));
    await nextTick();
    expect(root.textContent).toContain(`12 h of 40 h left this month`);
    expect(root.textContent).toContain(`Billing`);

    planOffered.value = false;
    await nextTick();
    expect(root.textContent).toContain(`12 h of 40 h left this month`);
    expect(root.textContent).not.toContain(`Billing`);
});
