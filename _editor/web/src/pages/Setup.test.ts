// @vitest-environment jsdom
//
// WHAT SETUP ASKS FOR ON ARRIVAL, which is the whole subject: nothing. Step 1 used to be a form — an empty field
// and a Create button that stayed dead until a word was typed — and the word bought nothing, since a name only
// tells sandboxes apart in a switcher the visitor has not seen yet. These mount the real page and read the first
// frame: that a sandbox exists without anyone naming it, that arriving on one already made does NOT make a
// second, and that the name it was given is still the user's to change.
import type { SandboxSummary } from "@intentic-app/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.

const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: {} }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// The device the page is read on — desktop unless a test flips it. The phone default is behavior of its own
// (the hosted rung takes it whenever one is offered); every other test below describes the desktop page.
const mobileDevice = ref(false);
vi.mock(import(`@intentic/ui`), async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, useDevice: (() => ({ ...actual.useDevice(), mobile: mobileDevice })) as typeof actual.useDevice };
});

// The sandbox registry, as the page sees it. `sandboxes` is what the auto-name counts against, `list` is the
// read on mount, and `create`/`update` are the two writes these tests are about.
const sandboxes = ref<SandboxSummary[]>([]);
const list = vi.fn<() => Promise<SandboxSummary[]>>();
const create = vi.fn<(name: string) => Promise<SandboxSummary>>();
const hostedProvision = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
const hostedRelease = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
const update = vi.fn<(id: string, input: { name?: string }) => Promise<SandboxSummary>>();
// The 3s poll's read. Named (rather than inline) because the wait card is driven entirely by what it returns:
// what the sandbox has said about its own boot, and whether we have been refusing its check-ins.
const refresh = vi.fn<() => Promise<SandboxSummary[]>>();
// The discard rule's one observable act: leaving without committing deletes the draft this page minted.
const remove = vi.fn<(id: string) => Promise<void>>();
vi.mock(`../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes,
        list,
        create,
        hostedProvision,
        hostedRelease,
        update,
        refresh,
        remove,
        select: vi.fn(),
        attach: vi.fn(),
    }),
}));

// The mint never settles, so step 3 stays locked and these tests stay about step 1 — no command, no highlighter.
// The hosted offer answers "not on this platform" unless a test says otherwise — the classic lanes' tests must
// keep describing the world without the hosted rung.
const setupCode = vi.fn(() => new Promise<never>(() => {}));
const hostedOffer = vi.fn().mockResolvedValue({ enabled: false, remaining: 0 });
// The platform hands out addresses unless a test says otherwise — that is the world every lane below assumes,
// and the one where a mint that never settles is a WAIT rather than a promise that was never on offer.
const addressOffer = vi.fn().mockResolvedValue({ enabled: true });
// The wait's two extra calls: the machine's power state (polled while waiting) and the restart its failures
// offer. Both answer harmlessly by default — a wait that cannot ask falls back to its plain step list.
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
vi.mock(`../environments/desktop`, () => ({
    DESKTOP_DOWNLOADS: [],
    desktopSetupLink: () => ``,
    desktopVersion: () => undefined,
    openDesktopLink: vi.fn(),
}));
// Steps 2-3's own surfaces: separate components with their own concerns, and none of them step 1's.
vi.mock(`./SetupCompose.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupHandoff.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupRunDetails.vue`, () => ({ default: defineComponent({ render: () => null }) }));
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
    // The mount read (list + the hosted offer) and the create it decides on are several awaits deep — a
    // macrotask flushes the whole chained sequence where a fixed count of ticks kept going stale.
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// A button whose whole label is this word — the "is there a Create button gating step 1" question, asked
// precisely. Substring matching answers it wrongly now that the ladder's cloud card says "Created in your own
// cloud account", which is prose about a machine rather than a control standing between the reader and their
// sandbox.
const buttonLabelled = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === text);

// The rename affordances are icons now, so they are found the way a screen reader finds them.
const renamePencil = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[aria-label="Rename sandbox"]`)!;
const saveName = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[aria-label="Save name"]`)!;

// The row that reports the name: climbed to from the pencil rather than read off a class, since the pencil and
// the value sit in separate cells of it (the in-place edit stacks each control over the one it replaces).
// Asserting on the row rather than the page keeps "workspace" from matching the page's own title, "Set up your
// workspace".
const nameRow = (): string => {
    let node: HTMLElement | null = renamePencil();
    while (node !== null && node.textContent?.includes(`Name`) !== true) {
        node = node.parentElement;
    }
    return node?.textContent ?? ``;
};

beforeEach(() => {
    mobileDevice.value = false;
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
    update.mockReset().mockImplementation(async (id: string, input: { name?: string }) => sandboxRow({ id, name: input.name ?? `` }));
    remove.mockReset().mockResolvedValue(undefined);
    push.mockReset();
});

// Leaving the page, the way every exit does it — the discard rule hangs off the unmount, so the tests below
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
it(`creates the sandbox on arrival, with no name asked for`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(nameRow()).toContain(`workspace`);
    expect(buttonLabelled(`Create`)).toBeUndefined();
});

/* THE DRAFT RULE — the price of creating on arrival, paid back.
 *
 * Creating the row before anything is asked for is what makes the first frame useful (the address mint needs a
 * row to hang off), and it used to be charged to the reader's switcher: opening this screen and going straight
 * back left a sandbox in their list, wearing a "Setup" chip, that they never asked to make. Looking at a thing
 * must not create it. So the row is a draft until an ACT says otherwise, and leaving without one deletes it —
 * the platform row and the tunnel the mint bought with it. */
it(`discards the sandbox it made when the reader leaves without committing`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    leave();
    expect(remove).toHaveBeenCalledWith(`new`);
});

// …and the acts that keep it are acts, never guesses. Typing a name over the one we picked is the cheapest of
// them and the easiest to get wrong: nobody renames a machine they are about to walk away from.
it(`keeps the sandbox once its name has been typed`, async () => {
    const el = await mount();
    renamePencil().click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = `shop`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    saveName().click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`new`, { name: `shop` }));
    leave();
    expect(remove).not.toHaveBeenCalled();
});

// A machine exists now — there is hardware behind this row, and deleting it on the way past would be throwing
// away the thing the reader just started.
it(`keeps the sandbox once a machine has been started for it`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) =>
        card.textContent?.includes(`Start instantly`),
    );
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`));
    leave();
    expect(remove).not.toHaveBeenCalled();
});

/* AND A RESUMED SANDBOX IS NEVER A DRAFT. It predates the visit — somebody made it on purpose and came back to
 * it — so leaving is setting it aside, not abandoning something that was created behind their back. Getting
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
 * that FAILED — and it is also the shape of every visit before the arrival read has answered, so the card
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
    expect(nameRow()).toContain(`workspace`);
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
    await mount();
    expect(create).not.toHaveBeenCalled();
    expect(nameRow()).toContain(`my-laptop`);
});

// The name is a default, not a decision taken away: changing it is one click from the step that reports it, and
// it goes to the row this page created — never to whichever sandbox happens to be selected.
it(`renames the sandbox it created, from the step itself`, async () => {
    const el = await mount();
    renamePencil().click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = `shop`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    saveName().click();
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(`new`, { name: `shop` }));
    await nextTick();
    expect(nameRow()).toContain(`shop`);
});

/* ON A PLATFORM THAT HOSTS, A FRESH SANDBOX DEFAULTS TO THE READER'S OWN COMPUTER.
 * The ladder offers the hosted machine beside it, and starting one is one click to that rung. */
it(`defaults a fresh sandbox to the reader's own computer, with hosted available on the ladder`, async () => {
    // Not `…Once`: the offer is the account's remaining allowance, and the page asks again every time it
    // spends or hands back a machine. A platform that hosts goes on hosting between two reads of it.
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    // The row is created the ordinary way — the lane only decides what machine is attached to it.
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
    // The wait names its steps rather than asserting one sentence at every problem — see hostedWait.ts.
    expect(el.textContent).toContain(`Starting the machine`);
    expect(el.textContent).toContain(`Putting it on the internet`);
});

/* A PHONE'S DEFAULT RUNG IS THE HOSTED MACHINE, whenever one is on offer. `cloud` held the phone default for
 * being the one lane a phone could finish alone — but it opens on a cloud credential paste, the hardest
 * possible first ask. The hosted rung finishes alone too, off a single tap. */
it(`defaults a phone to the hosted rung when one is offered`, async () => {
    mobileDevice.value = true;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) =>
        card.textContent?.includes(`Start instantly`),
    );
    expect(hostedRung?.getAttribute(`aria-checked`)).toBe(`true`);
    // The rung is described, never taken: nothing is provisioned until the button under it is pressed.
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(buttonLabelled(`Start my machine`)).toBeDefined();
    // No credential ask on a phone's first frame — the cloud rung is one tap away, never the opener.
    expect(el.textContent).not.toContain(`Private key`);
});

/* A refused provision (allowance spent, capacity weather, a misconfigured platform) must not strand the first
 * run, AND must not hide why: the sandbox that was already created carries on into the command lane with the
 * reason on the step. The silent version of this — bounce lanes, wipe the message — is what made the page
 * read as broken. */
it(`keeps the sandbox and says why when the machine is refused`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    hostedProvision.mockRejectedValue(new Error(`no capacity right now`));
    const el = await mount();
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) =>
        card.textContent?.includes(`Start instantly`),
    );
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(el.textContent).toContain(`no capacity right now`));
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(nameRow()).toContain(`workspace`);
    // The way out is the same button, now saying what pressing it would be.
    expect(buttonLabelled(`Try again`)).toBeDefined();
});

// A hosted sandbox resumed mid-boot (the tab closed during "starting") continues as the hosted story it is —
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
 * sentence — "Starting your machine" — to a machine that never booted, a sandbox nobody could reach, and a
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

    // The poll is what learns this — the row the page was mounted with knew nothing. It runs every 3s, so the
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

/* THE LADDER IS CARDS, AND A SWITCH MOVES A MACHINE — NOT THE SANDBOX. Picking another rung on a hosted
 * sandbox hands its machine back and keeps the row: same id, same name, no delete-and-recreate. */
it(`offers the rungs as readable cards, each stating its trade`, async () => {
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 1 });
    const el = await mount();
    const cards = [...el.querySelectorAll(`[role="radio"]`)];
    expect(cards).toHaveLength(3);
    // Not a bare label each: the cost and what it asks of you are on the card, before it is clicked.
    expect(cards[0]?.textContent).toContain(`Start instantly`);
    expect(cards[0]?.textContent).toContain(`Free`);
    // Whose machine the instant one is stays on the card — the title sells the speed, the note says where it runs.
    expect(cards[0]?.textContent).toContain(`Runs on our servers`);
    expect(cards[1]?.textContent).toContain(`One pasted command`);
    // What the reader's own machine actually wins over the free one, said where the choice is made rather
    // than discovered in week three.
    expect(cards[1]?.textContent).toContain(`no limits`);
});

/* THE FREE LANE'S PRICE IS ON ITS CARD, AND SO IS WHAT HAPPENS AFTER IT. "Free" alone, in the place a reader
 * looks for the cost, is the version of this that has to be corrected later — and so is a ceiling with no
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

// A member has no ceiling, so a member is shown none — the absence of the block is the whole contract.
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
    const hostedRung = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) =>
        card.textContent?.includes(`Start instantly`),
    );
    hostedRung!.click();
    await nextTick();
    buttonLabelled(`Start my machine`)!.click();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`));
    const mine = (): HTMLButtonElement =>
        [...el.querySelectorAll(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`)) as HTMLButtonElement;
    // The rungs are disabled while the machine is being made AND while the allowance that made it is re-read —
    // clicked before that settles, this does nothing, which is what the card is saying by being greyed out.
    await vi.waitFor(() => expect(mine().disabled).toBe(false));
    mine().click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`new`));
    expect(create).toHaveBeenCalledTimes(1); // the row survived the switch
    await nextTick();
    expect(nameRow()).toContain(`workspace`);
});

/* …AND THE RUNG IT CAME OFF IS STILL TAKEABLE. The allowance is the server's count of the machines this
 * account holds, and it used to be read once on arrival and never again — so a reader who resumed a hosted
 * sandbox (allowance spent, on that very machine) and then tried another rung was left in front of a page
 * that still counted the machine it had just handed back: the rung they had come off sat disabled under
 * "Already using yours", naming a machine that no longer existed, with no way back but a reload. */
it(`offers the hosted rung again once its machine has been handed back`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    // Spent on arrival — by this very sandbox — and free again the moment it is released.
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
 * the page took that as nothing at all — it had already offered the rungs that need an address, so they
 * flashed and vanished, over an address line that spun on "Preparing your intentic domain…" for as long as
 * anyone was willing to watch. Nothing is minted here and nothing is offered that cannot be delivered. */
it(`opens on the attach lane, with no spinner, when the platform mints no addresses`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    const el = await mount();
    // Not asked for: the code the platform has already said it will not mint.
    expect(setupCode).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Preparing your intentic domain`);
    // No rungs to retract — the ladder was never drawn, because there was never more than one thing on offer.
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    // What IS on offer, and why it is the only thing here.
    expect(el.textContent).toContain(`Connect your sandbox`);
    expect(el.textContent).toContain(`doesn't start sandboxes or hand out addresses`);
    // …and no way back to a lane that cannot finish: both labels of that link promise a machine or an address.
    expect(buttonLabelled(`← Get a domain from intentic instead`)).toBeUndefined();
});

/* The hosted rung survives an addressless platform: its machine is born holding its own tunnel, so it is the
 * one lane that never needed a mint. The reader stays on the provision spine — with no ladder, since there is
 * nothing left to choose between — rather than being sent to attach a sandbox they do not have. */
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
