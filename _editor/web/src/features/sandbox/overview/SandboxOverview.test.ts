// Pins that the logo tile is live at rest (not behind rename mode) and rename stays compact and independent.
// jsdom: mounts the component tree and reads rendered DOM.
import "@intentic/testing/dom";
import type { HostedPlanState, SandboxSummary } from "@intentic/api-contract";
import type { DeviceSandboxRow } from "@intentic/ui";
import { waitFor } from "@intentic/testing/bun";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { hostedLane, hostedMachine, hostedPlanState, spentHours } from "../../../testing/hostedPlan";

// Stubs the sandbox's other surfaces (version, workspace tree, availability) so only the identity block mounts.
const active = ref<SandboxSummary | undefined>(undefined);
const update = jest.fn<(sandboxId: string, input: { name?: string; image?: string | null }) => Promise<void>>().mockResolvedValue(undefined);
// Undefined by default, which leaves the facts block (image, version, URL) undrawn; a test about one of its lines sets it.
const daemonUrl = ref<string | undefined>(undefined);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active, update, daemonUrl, reachable: ref(true) }),
}));
// This container as its machine lists it. Undefined is a sandbox whose machine is not a connected device, which draws
// no Resources line at all; stubbed so the subject is who is offered the form, not how the row was found.
const selfRow = ref<DeviceSandboxRow | undefined>(undefined);
jest.mock(`../../../models/sandbox/devices/useSelfResources`, () => ({
    useSelfResources: () => ({
        row: selfRow,
        slug: computed(() => selfRow.value?.slug),
        current: computed(() => selfRow.value?.resources),
        engine: computed(() => undefined),
        reshapable: computed(() => selfRow.value?.resources !== undefined),
        canSave: computed(() => false),
        applying: ref(false),
        failure: ref(undefined),
        apply: () => Promise.resolve(),
        save: () => Promise.resolve(),
    }),
}));
const versionInfo = ref<{ image: string } | undefined>(undefined);
const installedVersion = ref<string | undefined>(undefined);
const latestVersion = ref<string | undefined>(undefined);
const updateAvailable = ref(false);
jest.mock(`../../../models/sandbox/useSandboxVersion`, () => ({
    useSandboxVersion: () => ({ info: versionInfo, installed: installedVersion, latest: latestVersion, updateAvailable }),
}));
jest.mock(`../../../models/workspace/tree/useWorkspaceTree`, () => ({ useWorkspaceTree: () => ({ hasSnapshot: ref(true) }) }));
const availability = ref<`live` | `warming` | `busy`>(`live`);
jest.mock(`./useSandboxAvailability`, () => ({ useSandboxAvailability: () => availability }));
// Where the sandbox runs is read off the fleet and the transport; stubbed for the same reason as the rest, so this
// suite mounts the identity block alone rather than the devices query behind it.
const placement = ref<{ kind: string; icon: string; label: string; detail: string } | undefined>(undefined);
jest.mock(`./useSandboxPlacement`, () => ({ useSandboxPlacement: () => placement }));
// The hosted plan's state is a plain ref here, not a query; the sentence read off it is hostedHours.ts's own.
const hostedPlan = ref<HostedPlanState | undefined>(undefined);
const planOffered = ref(false);
jest.mock(`../../../models/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ state: hostedPlan, offered: planOffered }) }));
jest.mock(`./version/SandboxUpdateCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`./version/SandboxBehindCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`./manifest/SandboxManifestCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// Reads the daemon's settings; pinned in SandboxSleepRow.test.ts.
jest.mock(`./SandboxSleepRow.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// jsdom has no 2d canvas context; stubs the resize and asserts only which fit (`contain`) was requested.
const fileToSquareDataUrl = jest.fn<(file: File, fit: `cover` | `contain`) => Promise<string>>().mockResolvedValue(`data:image/webp;base64,NEW`);
jest.mock(`../../../lib/imageDataUrl`, () => ({ fileToSquareDataUrl }));

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
    // The Resources form is a PrimeVue dialog and reads the plugin's config while rendering.
    app.use(PrimeVue);
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
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
};

beforeEach(() => {
    availability.value = `live`;
    versionInfo.value = undefined;
    installedVersion.value = undefined;
    latestVersion.value = undefined;
    updateAvailable.value = false;
    update.mockClear();
    fileToSquareDataUrl.mockClear();
});

afterEach(() => {
    daemonUrl.value = undefined;
    selfRow.value = undefined;
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

    await waitFor(() => expect(update).toHaveBeenCalledWith(`s1`, { name: `workbench` }));
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
    const opened = jest.spyOn(fileField(el), `click`);
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
    const remove = await waitFor(() => {
        const button = removeRow();
        expect(button).toEqual(expect.any(Object));
        return button!;
    });
    remove.click();
    await waitFor(() => expect(update).toHaveBeenCalledWith(`s1`, { image: null }));
});

it(`reports an unreadable file without writing anything`, async () => {
    fileToSquareDataUrl.mockRejectedValueOnce(new Error(`nope`));
    const el = mount(sandboxRow());
    const field = fileField(el);
    Object.defineProperty(field, `files`, { value: [new File([`x`], `logo.png`, { type: `image/png` })], configurable: true });
    field.dispatchEvent(new Event(`change`));
    await waitFor(() => expect(el.textContent).toContain(`Couldn't read that file as an image.`));
    expect(update).not.toHaveBeenCalled();
});

/* THIS SANDBOX'S HOURS, not the account's: the card reads the machine it stands on out of the plan state, so a sandbox
 * whose machine spends the free hours says so, and one the reader holds no machine for says nothing. */
it(`states this sandbox's own hours on the hosted card, with Billing where a plan is sold`, async () => {
    hostedPlan.value = hostedPlanState(hostedLane([hostedMachine(`s1`, spentHours(1_680))], spentHours(1_680)));
    planOffered.value = true;
    const root = mount(sandboxRow({ role: `owner`, hosted: { region: `arn`, warm: true } }));
    await nextTick();
    expect(root.textContent).toContain(`Free hours · 12h of 40h left this month`);
    expect(root.textContent).toContain(`Billing`);

    planOffered.value = false;
    await nextTick();
    expect(root.textContent).toContain(`Free hours · 12h of 40h left this month`);
    expect(root.textContent).not.toContain(`Billing`);
});

// Structural wrap/shrink assertions complement the real-browser pane audit; jsdom cannot measure CSS layout.
it(`keeps long image, installed and available versions in full within stackable facts`, () => {
    const image = `ghcr.io/intentic/sandbox:stable-2026.10.10-4f5dd184296f1351fa2f795d36b4d3c7081a4f9c`;
    const installed = `2026.10.03-stable-4f5dd184296f1351fa2f795d36b4d3c7081a4f9c`;
    const latest = `2026.10.10-stable-729f184f364d3c7081a4f9c2f795d36b4d3c7081a4f9c`;
    versionInfo.value = { image };
    installedVersion.value = installed;
    latestVersion.value = latest;
    updateAvailable.value = true;
    const el = mount(sandboxRow());
    const facts = el.querySelector(`dl`)!;
    expect(facts.textContent).toContain(image);
    expect(facts.textContent).toContain(installed);
    expect(facts.textContent).toContain(latest);
    expect(facts.querySelector(`.truncate`)).toBeNull();
    expect(facts.querySelector(`dd`)?.classList.contains(`[overflow-wrap:anywhere]`)).toBe(true);
    expect(facts.firstElementChild?.classList.contains(`grid`)).toBe(true);
});

it(`bounds a long Sandbox URL's text independently of its external-link icon without changing the address`, () => {
    const url = `https://sandbox-82789f4106b4-long-descriptive-address.demo.invalid`;
    daemonUrl.value = url;
    const el = mount(sandboxRow());
    const link = el.querySelector<HTMLAnchorElement>(`dl a`)!;
    expect(link.getAttribute(`href`)).toBe(url);
    expect(link.getAttribute(`target`)).toBe(`_blank`);
    expect(link.classList.contains(`max-w-full`)).toBe(true);
    expect(link.classList.contains(`truncate`)).toBe(false);
    const text = link.firstElementChild!;
    expect(text.textContent).toBe(url);
    expect(text.classList.contains(`min-w-0`)).toBe(true);
    expect(text.classList.contains(`[overflow-wrap:anywhere]`)).toBe(true);
    expect(link.lastElementChild?.classList.contains(`shrink-0`)).toBe(true);
});

/* THIS SANDBOX'S SHARE OF ITS MACHINE: changing it is a device op, maintainer and up at the daemon, so the form is a
 * maintainer's as much as the owner's. Writer, the tier just under that floor, gets the fact without a button the
 * daemon would refuse. */
const onConnectedMachine = (): void => {
    daemonUrl.value = `https://sandbox-abc.example.test`;
    selfRow.value = {
        slug: `sandbox-abc`,
        running: true,
        image: `ghcr.io/intentic/sandbox:2.3.1`,
        resources: { memoryBytes: 12 * 1024 ** 3, cpus: 4, privileged: false, gpu: false, hostRuntime: [], overlayRuntime: [] },
    };
};
const changeButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `Change…`);

it(`hands a maintainer the Resources form, not the owner alone`, async () => {
    onConnectedMachine();
    const el = mount(sandboxRow({ role: `maintainer` }));
    expect(el.textContent).toContain(`12 GiB · 4 CPUs`);
    changeButton(el)?.click();
    await waitFor(() => expect(document.body.textContent).toContain(`Resources for radarsu-intentic`));
});

it(`gives a member below maintainer the share without the button`, () => {
    onConnectedMachine();
    const el = mount(sandboxRow({ role: `writer` }));
    expect(el.textContent).toContain(`12 GiB · 4 CPUs`);
    expect(changeButton(el)).toBeUndefined();
});
