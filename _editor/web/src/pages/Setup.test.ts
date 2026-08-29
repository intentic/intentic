// @vitest-environment jsdom
//
// WHAT SETUP ASKS FOR ON ARRIVAL, which is the whole subject: nothing. Step 1 used to be a form, an empty field
// and a Create button that stayed dead until a word was typed, and the word bought nothing, since a name only
// tells sandboxes apart in a switcher the visitor has not seen yet. Naming is not on this page at all any more,
// in any form: no field, no pencil, nothing to press to grow one. It belongs in the workspace, where there are
// several machines to tell apart. These mount the real page and read the first frame: that a sandbox exists
// without anyone naming it, and that arriving on one already made does NOT make a second.
import type { SandboxSummary } from "@intentic-app/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.

const push = vi.fn();
// The URL the page was opened with. Empty unless a test sets it: the query carries where the reader came
// FROM (`?sandbox=` resumes one, `?machine=` names a rung already chosen on the public site), so it is an
// arrival fact and every test that does not set it describes a cold, linkless visit.
const query = ref<Record<string, string>>({});
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ get query() { return query.value; } }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
    // "Back to workspace" is a link now, and the real one resolves its href out of a router this bare mount
    // never installs.
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

// The device the page is read on: desktop unless a test flips it. The phone default is behavior of its own
// (the hosted rung takes it whenever one is offered); every other test below describes the desktop page.
const mobileDevice = ref(false);
vi.mock(import(`@intentic/ui`), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useDevice: (() => ({ ...actual.useDevice(), mobile: mobileDevice })) as typeof actual.useDevice,
        // The command block, minus its highlighter. Shiki loads grammars asynchronously and none of the tests
        // below are about syntax colouring: they are about whether the command is on screen at all, which a
        // <pre> answers exactly as well and in one tick.
        Code: defineComponent({ props: { code: String }, render: () => null }) as unknown as typeof actual.Code,
    };
});

// The sandbox registry, as the page sees it. `sandboxes` is what the auto-name counts against, `list` is the
// read on mount, and `create` is the one write this page makes to the row itself.
const sandboxes = ref<SandboxSummary[]>([]);
const list = vi.fn<() => Promise<SandboxSummary[]>>();
const create = vi.fn<(name: string) => Promise<SandboxSummary>>();
const hostedProvision = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
const hostedRelease = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
// The 3s poll's read. Named (rather than inline) because the wait card is driven entirely by what it returns:
// what the sandbox has said about its own boot, and whether we have been refusing its check-ins.
const refresh = vi.fn<() => Promise<SandboxSummary[]>>();
// The discard rule's one observable act: leaving without committing deletes the draft this page minted.
const remove = vi.fn<(id: string) => Promise<void>>();
// `activeSandboxId` and `reachable` are not this page's own reads: they are the chat store's, which arrives in
// this graph because finishing setup now HANDS OVER to a chat (see `enterWorkspace`). The store reads them at
// module scope, so leaving them out is an import-time crash rather than a missing feature.
vi.mock(`../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes,
        list,
        create,
        hostedProvision,
        hostedRelease,
        refresh,
        remove,
        select: vi.fn(),
        attach: vi.fn(),
        activeSandboxId: ref<string | undefined>(undefined),
        reachable: ref(false),
    }),
}));

// The mint never settles, so step 3 stays locked and these tests stay about step 1: no command, no highlighter.
// The hosted offer answers "not on this platform" unless a test says otherwise: the classic lanes' tests must
// keep describing the world without the hosted rung.
type Minted = { code: string; hostname: string; expiresAt: string };
const setupCode = vi.fn<() => Promise<Minted>>(() => new Promise<Minted>(() => {}));
const hostedOffer = vi.fn().mockResolvedValue({ enabled: false, remaining: 0 });
// The platform hands out addresses unless a test says otherwise: that is the world every lane below assumes,
// and the one where a mint that never settles is a WAIT rather than a promise that was never on offer.
const addressOffer = vi.fn().mockResolvedValue({ enabled: true });
// The wait's two extra calls: the machine's power state (polled while waiting) and the restart its failures
// offer. Both answer harmlessly by default: a wait that cannot ask falls back to its plain step list.
const hostedStatus = vi.fn().mockResolvedValue({ machine: `unknown` });
const hostedRestart = vi.fn().mockResolvedValue({ ok: true });
vi.mock(`../composables/useApi`, () => ({ apiClient: { sandbox: { setupCode, hostedOffer, addressOffer, hostedStatus, hostedRestart } } }));
vi.mock(`../composables/sandbox/sandboxIdFromToken`, () => ({ sandboxIdFromToken: vi.fn().mockResolvedValue(`0f310c3c4db4`) }));
vi.mock(`../composables/analytics`, () => ({ track: vi.fn() }));
vi.mock(`../composables/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../composables/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({ getIdToken: vi.fn().mockResolvedValue(`id-token`), warmIdToken: vi.fn() }),
}));
vi.mock(`../composables/useNow`, () => ({ useNow: () => ref(0) }));
vi.mock(`../composables/extensions/useCloudflareZones`, () => ({
    useCloudflareZones: () => ({
        cfToken: ref(``),
        cfTokenValid: ref(false),
        selectedZone: ref(undefined),
        zones: ref([]),
        zonesLoading: ref(false),
        zonesError: ref(undefined),
    }),
}));
// Which installer this reader's machine can run decides whether the own-computer lane leads with a download or
// with the command, so it is a knob every test below can turn. Undefined by default: the Mac-shaped world,
// where the command is still the path, which is what most of these tests were written against.
const desktopInstaller = vi.fn<() => { platform: string; label: string; href: string } | undefined>(() => undefined);
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_DOWNLOADS: [],
    desktopInstaller: () => desktopInstaller(),
    desktopSetupLink: () => ``,
    desktopVersion: () => undefined,
    openDesktopLink: vi.fn(),
}));
// Steps 2-3's own surfaces: separate components with their own concerns, and none of them step 1's.
vi.mock(`./SetupCompose.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupHandoff.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupRunDetails.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupSyncOption.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../components/CloudflareTokenField.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Setup } = await import("./Setup.vue");

const sandboxRow = (overrides: Partial<SandboxSummary> = {}): SandboxSummary =>
    ({
        id: `s1`,
        name: `workspace`,
        image: null,
        daemonUrl: null,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        token: `tok`,
        role: `owner`,
        providedTunnel: false,
        cloud: null,
        hosted: null,
        ...overrides,
    }) as SandboxSummary;

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Setup) });
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
    // The mount read (list + the hosted offer) and the create it decides on are several awaits deep: a
    // macrotask flushes the whole chained sequence where a fixed count of ticks kept going stale.
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// A button whose whole label is this word: the "is there a Create button gating step 1" question, asked
// precisely. Substring matching answers it wrongly now that the ladder's cloud card says "Created in your own
// cloud account", which is prose about a machine rather than a control standing between the reader and their
// sandbox.
const buttonLabelled = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === text);

// The same question for a button that is an <a>: a download is a navigation, so the installer offer is a link
// wearing a button's clothes, and asking for a <button> would answer "no such control" about one on screen.
const linkLabelled = (text: string): HTMLAnchorElement | undefined =>
    [...document.querySelectorAll(`a`)].find((link) => link.textContent?.trim() === text);

// Anything on the page whose whole text is this: the leaf that holds a value, rather than every ancestor that
// contains it. Used to ask WHERE something is, which is a question about one element and not about a subtree.
const nodeWithText = (text: string): Element =>
    [...document.querySelectorAll(`*`)].find((node) => node.children.length === 0 && node.textContent?.trim() === text)!;

// Does it sit after the rung picker in the page's own order? The picker is the landmark this page is measured
// against: what a stranger reads BEFORE the only choice on it is what decides whether they reach the choice.
const afterThePicker = (text: string): boolean =>
    (document.querySelector(`[role="radiogroup"]`)!.compareDocumentPosition(nodeWithText(text)) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// A settled mint, so the run card gets past its lock and renders the thing the reader came for. The tests that
// predate this one deliberately leave the mint hanging, which is what keeps them about step 1.
const MINTED = { code: `vphf-3wk`, hostname: `sandbox-fa0b431303b8.sbx.intentic.dev`, expiresAt: new Date(Date.now() + 600_000).toISOString() };

beforeEach(() => {
    query.value = {};
    mobileDevice.value = false;
    desktopInstaller.mockReset().mockReturnValue(undefined);
    setupCode.mockReset().mockImplementation(() => new Promise<Minted>(() => {}));
    sandboxes.value = [];
    list.mockReset().mockResolvedValue([]);
    refresh.mockReset().mockResolvedValue([]);
    hostedStatus.mockReset().mockResolvedValue({ machine: `unknown` });
    hostedRestart.mockReset().mockResolvedValue({ ok: true });
    hostedProvision.mockReset().mockImplementation(async (id: string) => sandboxRow({ id, hosted: { region: `iad`, warm: true } }));
    hostedRelease.mockReset().mockImplementation(async (id: string) => sandboxRow({ id }));
    hostedOffer.mockReset().mockResolvedValue({ enabled: false, remaining: 0 });
    addressOffer.mockReset().mockResolvedValue({ enabled: true });
    create.mockReset().mockImplementation(async (name: string) => {
        const row = sandboxRow({ id: `new`, name });
        sandboxes.value = [...sandboxes.value, row];
        return row;
    });
    remove.mockReset().mockResolvedValue(undefined);
    push.mockReset();
});

// Leaving the page, the way every exit does it: the discard rule hangs off the unmount, so the tests below
// have to actually take the page down rather than assert on a flag.
const leave = (): void => {
    app?.unmount();
    app = undefined;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The regression this file is named for: a fresh account gets a sandbox by arriving, and is never shown a field.
// Asserted by SHAPE rather than against the label the field used to wear: there is nothing to type into on this
// page, and no control that grows one, whatever such a thing would be called.
it(`creates the sandbox on arrival, with no name asked for`, async () => {
    const el = await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(buttonLabelled(`Create`)).toBeUndefined();
    expect(el.querySelector(`input`)).toBeNull();
    expect([...el.querySelectorAll(`button`)].some((button) => /name/i.test(button.getAttribute(`aria-label`) ?? ``))).toBe(false);
});

/* THE DRAFT RULE: the price of creating on arrival, paid back.
 *
 * Creating the row before anything is asked for is what makes the first frame useful (the address mint needs a
 * row to hang off), and it used to be charged to the reader's switcher: opening this screen and going straight
 * back left a sandbox in their list, wearing a "Setup" chip, that they never asked to make. Looking at a thing
 * must not create it. So the row is a draft until an ACT says otherwise, and leaving without one deletes it:
 * the platform row and the tunnel the mint bought with it. */
it(`discards the sandbox it made when the reader leaves without committing`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    leave();
    expect(remove).toHaveBeenCalledWith(`new`);
});

// …and the acts that keep it are acts, never guesses. A machine exists now: there is hardware behind this row,
// and deleting it on the way past would be throwing away the thing the reader just started.
it(`keeps the sandbox once a machine has been started for it`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`Start instantly`));
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`));
    leave();
    expect(remove).not.toHaveBeenCalled();
});

/* AND A RESUMED SANDBOX IS NEVER A DRAFT. It predates the visit: somebody made it on purpose and came back to
 * it, so leaving is setting it aside, not abandoning something that was created behind their back. Getting
 * this wrong would delete the very row the page was opened to finish. */
it(`never discards a sandbox it merely resumed`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    await mount();
    expect(create).not.toHaveBeenCalled();
    leave();
    expect(remove).not.toHaveBeenCalled();
});

/* THE FIRST FRAME, WHICH USED TO BE AN ERROR SCREEN. "No row, and not creating one" is the shape of a create
 * that FAILED, and it is also the shape of every visit before the arrival read has answered, so the card
 * opened on "Try again" and corrected itself a round-trip later. In the desktop app, where this page IS the
 * window that just opened, that read as an error flashing on launch. Nothing is claimed until something is
 * known. */
it(`says nothing about the sandbox until the arrival read answers`, async () => {
    let answer: (rows: SandboxSummary[]) => void = () => {};
    list.mockReset().mockImplementation(async () => new Promise<SandboxSummary[]>((resolve) => (answer = resolve)));
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Setup) });
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    expect(buttonLabelled(`Try again`)).toBeUndefined();
    expect(el.textContent).not.toContain(`Connect it by domain`);
    // …and once it does answer, the page is itself again.
    answer([]);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    expect(el.querySelector(`[role="radiogroup"]`)).not.toBeNull();
});

// "Add sandbox" from a shell that already has one: the default counts past the names the account holds rather
// than colliding with them.
it(`numbers the next sandbox instead of colliding with the first`, async () => {
    const existing = sandboxRow({ id: `s1`, name: `workspace`, lastSeenAt: `2026-08-06T00:00:00.000Z` });
    sandboxes.value = [existing];
    list.mockResolvedValue([existing]);
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace-2`);
});

// Leaving mid-setup and coming back is normal, and it must not pile up rows: the unfinished sandbox is resumed.
it(`resumes an unfinished sandbox rather than making a second`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    /* …AND SAYS NOTHING ABOUT IT, because nothing has happened to this row. It exists only because this page
     * makes one on arrival, and every ordinary second visit lands here: a reload, a tab reopened, `/` bouncing
     * off requireSetup — and above all the DESKTOP APP, whose webview loads the SPA at `/` and is redirected
     * here on its first frame. "Picking up where you left off: nothing has run yet. Use a new sandbox instead."
     * was therefore the first sentence the app showed a person who had been signed up for thirty seconds,
     * telling them they had a past here and offering to throw away the only sandbox they had. */
    expect(el.textContent).not.toContain(`Picking up where you left off`);
    expect(el.textContent).not.toContain(`Use a new sandbox instead`);
});

it(`does say where you left off once something has actually happened to the sandbox`, async () => {
    // A machine redeemed the code: the command demonstrably ran somewhere, so this IS an errand in progress
    // and the offer to start over is a real one.
    const started = sandboxRow({ id: `s1`, name: `my-laptop`, setupCodeClaimedAt: new Date().toISOString() });
    sandboxes.value = [started];
    list.mockResolvedValue([started]);
    const el = await mount();
    expect(el.textContent).toContain(`Picking up where you left off`);
    expect(el.textContent).toContain(`Use a new sandbox instead`);
});

/* ON A PLATFORM THAT HOSTS, A FRESH SANDBOX DEFAULTS TO THE READER'S OWN COMPUTER.
 * The ladder offers the hosted machine beside it, and starting one is one click to that rung. */
it(`defaults a fresh sandbox to the reader's own computer, with hosted available on the ladder`, async () => {
    // Not `…Once`: the offer is the account's remaining allowance, and the page asks again every time it
    // spends or hands back a machine. A platform that hosts goes on hosting between two reads of it.
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    // The row is created the ordinary way: the lane only decides what machine is attached to it.
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Starting the machine`);
    // Default rung is the reader's own computer, never the hosted machine
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    const hostedRung = rungs.find((card) => card.textContent?.includes(`Start instantly`));
    const mineRung = rungs.find((card) => card.textContent?.includes(`My own computer`));
    expect(mineRung?.getAttribute(`aria-checked`)).toBe(`true`);
    expect(hostedRung?.getAttribute(`aria-checked`)).toBe(`false`);
    expect(buttonLabelled(`Start my machine`)).toBeUndefined();

    // Clicking the hosted rung reveals the commitment and Start my machine
    hostedRung!.click();
    await nextTick();
    expect(buttonLabelled(`Start my machine`)).toBeDefined();
    expect(el.textContent).toContain(`don't back it up`);

    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`));
    await nextTick();
    // The wait names its steps rather than asserting one sentence at every problem: see hostedWait.ts.
    expect(el.textContent).toContain(`Starting the machine`);
    expect(el.textContent).toContain(`Putting it on the internet`);
});

/* A PHONE'S DEFAULT RUNG IS THE HOSTED MACHINE, whenever one is on offer. `cloud` held the phone default for
 * being the one lane a phone could finish alone, but it opens on a cloud credential paste, the hardest
 * possible first ask. The hosted rung finishes alone too, off a single tap. */
it(`defaults a phone to the hosted rung when one is offered`, async () => {
    mobileDevice.value = true;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`Start instantly`));
    expect(hostedRung?.getAttribute(`aria-checked`)).toBe(`true`);
    // The rung is described, never taken: nothing is provisioned until the button under it is pressed.
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(buttonLabelled(`Start my machine`)).toBeDefined();
    // No credential ask on a phone's first frame: the cloud rung is one tap away, never the opener.
    expect(el.textContent).not.toContain(`Private key`);
});

/* A RUNG ALREADY CHOSEN, off `?machine=`: the public site's /where-it-runs cards link through it. That page
 * has the room to say what each rung costs and asks of you, which this one does not and should not; the
 * price of the split is that a click there has to survive the trip. Landing back on the default rung would
 * make the reader choose twice and teach them the first choice was decoration. */
it(`opens on the rung the reader chose before arriving`, async () => {
    query.value = { machine: `cloud` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.find((card) => card.textContent?.includes(`My cloud account`))?.getAttribute(`aria-checked`)).toBe(`true`);
    expect(rungs.find((card) => card.textContent?.includes(`Start instantly`))?.getAttribute(`aria-checked`)).toBe(`false`);
});

// …and it outranks the DEVICE default, which is only ever a guess at what this reader can finish. A phone on
// `?machine=mine` is somebody reading on their phone about the desktop they are sitting at, and handing the
// command to that machine is a step this page already has.
it(`lets a chosen rung override the phone default`, async () => {
    query.value = { machine: `mine` };
    mobileDevice.value = true;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.find((card) => card.textContent?.includes(`My own computer`))?.getAttribute(`aria-checked`)).toBe(`true`);
});

/* A LINK FOR A RUNG THIS PLATFORM DOES NOT OFFER IS IGNORED, not honoured into a dead step. The site is
 * cached and its cards are the same HTML for every platform; a self-hoster who mints no addresses would
 * otherwise land arrivals on a command lane that can never unlock, from a link they cannot edit. */
it(`ignores a rung the platform is not offering`, async () => {
    query.value = { machine: `hosted` };
    hostedOffer.mockResolvedValue({ enabled: false, remaining: 0 });
    const el = await mount();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.some((card) => card.textContent?.includes(`Start instantly`))).toBe(false);
    expect(rungs.find((card) => card.textContent?.includes(`My own computer`))?.getAttribute(`aria-checked`)).toBe(`true`);
});

/* THE HOSTNAME IS NOT THE FIRST THING A STRANGER READS. It used to be the second line of the card that opens
 * the page: a hex address nobody typed, nobody can parse and nobody is deciding, with an advanced escape
 * hatch ("Use a different address") beside it, above the only choice on the page. It is a consequence of the
 * rung, so it reports itself on the card the rung chose, next to the command that carries it. */
it(`reports the address on the run card rather than above the choice`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(MINTED.hostname));
    // Both the address and the way off it are read by somebody who has already picked a rung: neither is
    // something a stranger has to get past to reach the choice.
    expect(afterThePicker(MINTED.hostname)).toBe(true);
    expect(afterThePicker(`Use a different address`)).toBe(true);
});

/* THE OWN-COMPUTER LANE LEADS WITH AN INSTALLER wherever we ship a build for the machine reading the page.
 * `curl … | sudo sh` was this lane's opening move, preselected and above the fold, which exposes the reader
 * who is scared of it and protects the one who isn't. The command is a labelled click away, and the reader who
 * wants it is the one reader guaranteed to recognise the link. */
it(`offers the app first on a machine we ship a build for, with the command one click away`, async () => {
    desktopInstaller.mockReturnValue({ platform: `windows`, label: `Windows`, href: `https://intentic.dev/desktop/windows` });
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(linkLabelled(`Download for Windows`)).toBeDefined());
    expect(linkLabelled(`Download for Windows`)!.getAttribute(`href`)).toBe(`https://intentic.dev/desktop/windows`);
    // Nothing about a terminal on the first frame, not the paste instruction, not the `sudo` switch.
    expect(el.textContent).not.toContain(`Paste it into a terminal`);
    expect(el.textContent).not.toContain(`I already have Docker`);
    // …and the wait under it names the move it is actually waiting on.
    expect(el.textContent).toContain(`Nothing runs until you install the app above`);

    // The alternatives are NAMED on screen rather than folded behind a question ("Prefer a terminal?"), and the
    // one that opens the command says what it opens.
    expect(el.textContent).toContain(`Other ways to set up`);
    const showCommand = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Show the command`);
    showCommand!.click();
    await nextTick();
    expect(el.textContent).toContain(`Paste it into a terminal`);
});

// …and where there is none (macOS today) the command stays the path. A button pointing at a downloads page
// with nothing on it for you is worse than the pipe it would displace.
it(`keeps the command first where there is no build for the reader's machine`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(`Paste it into a terminal`));
    expect(linkLabelled(`Download for Windows`)).toBeUndefined();
    expect(linkLabelled(`Download for Linux`)).toBeUndefined();
    // Nothing to offer as an alternative here: the command IS the path, so the row of other ways is absent
    // rather than pointing at what is already on screen.
    expect(el.textContent).not.toContain(`Other ways to set up`);
});

/* A refused provision (allowance spent, capacity weather, a misconfigured platform) must not strand the first
 * run, AND must not hide why: the sandbox that was already created carries on into the command lane with the
 * reason on the step. The silent version of this (bounce lanes, wipe the message) is what made the page
 * read as broken. */
it(`keeps the sandbox and says why when the machine is refused`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    hostedProvision.mockRejectedValue(new Error(`no capacity right now`));
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`Start instantly`));
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(el.textContent).toContain(`no capacity right now`));
    // The row the page made on arrival carries on: not deleted, not made again in another lane.
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    // The way out is the same button, now saying what pressing it would be.
    expect(buttonLabelled(`Try again`)).toBeDefined();
});

// A hosted sandbox resumed mid-boot (the tab closed during "starting") continues as the hosted story it is:
// the wait card, never a command to run for a machine nobody has to touch.
it(`resumes a hosted sandbox onto the wait card, not the command lane`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Starting the machine`);
});

/* WHAT THE WAIT SAYS WHEN IT GOES WRONG, which is the reason any of this exists. The card used to show one
 * sentence ("Starting your machine") to a machine that never booted, a sandbox nobody could reach, and a
 * sandbox we were refusing every time it spoke. People sat through a wedged tunnel because nothing on screen
 * distinguished it from a slow boot.
 *
 * The refused check-in is the shape a half-migrated sandbox takes: alive, talking, and turned away every time.
 * Waiting can never fix it, so the card has to say so and offer the one thing that can. */
it(`names a refused check-in on the wait card, with a way out`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    refresh.mockResolvedValue([{ ...hosted, announceRefusal: { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` } }]);
    const el = await mount();

    // The poll is what learns this: the row the page was mounted with knew nothing. It runs every 3s, so the
    // wait here is for one tick of it rather than for a render.
    await vi.waitFor(() => expect(el.textContent).toContain(`old.example.dev`), { timeout: 6_000, interval: 50 });
    expect(el.textContent).toContain(`sandbox-abc.sbx.test`);
    // …and the step list is gone: a list still ticking beside "here is what broke" argues with itself.
    expect(el.textContent).not.toContain(`Putting it on the internet`);

    // The address is built into this machine, so the way out is a new one rather than another boot.
    const restart = [...el.querySelectorAll<HTMLElement>(`button`)].find((button) => button.textContent?.includes(`Start it over`));
    restart!.click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`h1`));
    expect(hostedProvision).toHaveBeenCalledWith(`h1`);
    expect(hostedRestart).not.toHaveBeenCalled();
});

/* THE LADDER IS CARDS, AND A SWITCH MOVES A MACHINE: NOT THE SANDBOX. Picking another rung on a hosted
 * sandbox hands its machine back and keeps the row: same id, same name, no delete-and-recreate. */
it(`offers the rungs as readable cards, each stating its trade`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    const cards = [...el.querySelectorAll(`[role="radio"]`)];
    expect(cards).toHaveLength(3);
    // Not a bare label each: the cost and what it asks of you are on the card, before it is clicked.
    expect(cards[0]?.textContent).toContain(`Start instantly`);
    expect(cards[0]?.textContent).toContain(`Free`);
    // Whose machine the instant one is stays on the card: the title sells the speed, the note says where it runs.
    expect(cards[0]?.textContent).toContain(`Runs on our servers`);
    expect(cards[1]?.textContent).toContain(`One pasted command`);
    // What the reader's own machine actually wins over the free one, said where the choice is made rather
    // than discovered in week three.
    expect(cards[1]?.textContent).toContain(`no limits`);
});

/* THE FREE LANE'S PRICE IS ON ITS CARD, AND SO IS WHAT HAPPENS AFTER IT. "Free" alone, in the place a reader
 * looks for the cost, is the version of this that has to be corrected later, and so is a ceiling with no
 * answer to "and then?", which is the question a price is read to settle.
 * The sentences that go with it are NOT on the card: three rungs of small print, side by side, is not a
 * picker. They follow the selection, one rung's worth at a time. */
it(`states the hour ceiling and what follows it on the hosted card, with the small print beside the button`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
    const el = await mount();
    const hosted = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)][0];
    expect(hosted?.textContent).toContain(`40h a month, more with membership`);
    hosted!.click();
    await nextTick();
    // The card stays three lines: what this machine's disk is, the reader reads where they commit to it.
    expect(hosted?.textContent).not.toContain(`back it up`);
    expect(el.textContent).toContain(`don't back it up`);
    expect(el.textContent).toContain(`it's removed`);
});

// A member has no ceiling, so a member is shown none: the absence of the block is the whole contract.
it(`says nothing about hours to someone they do not apply to`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    const hosted = [...el.querySelectorAll(`[role="radio"]`)][0];
    expect(hosted?.textContent).toContain(`ready in seconds`);
    expect(hosted?.textContent).not.toContain(`a month`);
    expect(hosted?.textContent).not.toContain(`we remove it`);
});

it(`hands the machine back when another rung is chosen, keeping the same sandbox`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`Start instantly`));
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`));
    const mine = (): HTMLButtonElement =>
        [...el.querySelectorAll(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`)) as HTMLButtonElement;
    // The rungs are disabled while the machine is being made AND while the allowance that made it is re-read:
    // clicked before that settles, this does nothing, which is what the card is saying by being greyed out.
    await vi.waitFor(() => expect(mine().disabled).toBe(false));
    mine().click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`new`));
    expect(create).toHaveBeenCalledTimes(1); // the row survived the switch
    expect(remove).not.toHaveBeenCalled();
});

/* …AND THE RUNG IT CAME OFF IS STILL TAKEABLE. The allowance is the server's count of the machines this
 * account holds, and it used to be read once on arrival and never again, so a reader who resumed a hosted
 * sandbox (allowance spent, on that very machine) and then tried another rung was left in front of a page
 * that still counted the machine it had just handed back: the rung they had come off sat disabled under
 * "Already using yours", naming a machine that no longer existed, with no way back but a reload. */
it(`offers the hosted rung again once its machine has been handed back`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    // Spent on arrival: by this very sandbox, and free again the moment it is released.
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 0 }).mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const rung = (label: string): HTMLButtonElement =>
        [...el.querySelectorAll(`[role="radio"]`)].find((card) => card.textContent?.includes(label)) as HTMLButtonElement;

    rung(`My own computer`).click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`h1`));
    await vi.waitFor(() => expect(rung(`Start instantly`).disabled).toBe(false));
    expect(el.textContent).not.toContain(`Already using yours`);
});

/* A PLATFORM THAT HANDS OUT NO ADDRESSES SAYS SO, IN THE FIRST FRAME. This is the state that read as the page
 * being broken: the mint 404s (its tunnel fabric is a deployment choice, and self-hosters leave it off), and
 * the page took that as nothing at all: it had already offered the rungs that need an address, so they
 * flashed and vanished, over an address line that spun on "Preparing your intentic domain…" for as long as
 * anyone was willing to watch. Nothing is minted here and nothing is offered that cannot be delivered. */
it(`opens on the attach lane, with no spinner, when the platform mints no addresses`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    const el = await mount();
    // Not asked for: the code the platform has already said it will not mint.
    expect(setupCode).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Preparing your intentic domain`);
    // No rungs to retract: the ladder was never drawn, because there was never more than one thing on offer.
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    // What IS on offer, and why it is the only thing here.
    expect(el.textContent).toContain(`Connect your sandbox`);
    expect(el.textContent).toContain(`doesn't start sandboxes or hand out addresses`);
    // …and no way back to a lane that cannot finish: both labels of that link promise a machine or an address.
    expect(buttonLabelled(`← Get a domain from intentic instead`)).toBeUndefined();
});

/* The hosted rung survives an addressless platform: its machine is born holding its own tunnel, so it is the
 * one lane that never needed a mint. The reader stays on the provision spine: with no ladder, since there is
 * nothing left to choose between: rather than being sent to attach a sandbox they do not have. */
it(`keeps the hosted lane when the platform hosts but mints no addresses`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    expect(buttonLabelled(`Start my machine`)).toBeDefined();
    expect(el.textContent).not.toContain(`Connect your sandbox`);
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
});

/* …and when that hosted machine is already spent, the rung is offered but not TAKEABLE, which is the same
 * nothing as having no rungs at all. The reader belongs in the attach lane rather than in front of a hosted
 * card that refuses and a locked step behind a picker the page has hidden for having one option. */
it(`falls to the attach lane when the only rung left is a hosted machine already spent`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 0 });
    const el = await mount();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Connect your sandbox`);
    expect(setupCode).not.toHaveBeenCalled();
});
