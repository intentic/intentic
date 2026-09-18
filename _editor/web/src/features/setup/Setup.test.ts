// @vitest-environment jsdom
// Pins that setup asks for neither a name (moved to the workspace) nor a machine (decided by surface, setupArrival.ts).
// Defaults to a platform that hosts nothing, the world that leaves the command lane on screen.
import type { SandboxSummary } from "@intentic/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Both useDevice (matchMedia) and environment.ts (window.env) read globals at module scope on import.

const push = vi.fn();
const replace = vi.fn();
// Query string the page was opened with; unset means a cold, linkless visit.
const query = ref<Record<string, string>>({});
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
        }) as never,
    useRouter: () => ({ push, replace }) as never,
    // RouterLink stub: the real component resolves its href from a router this bare mount never installs.
    RouterLink: (await import(`../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

// Desktop unless a test flips it; the phone default is its own behavior (auto-picks the hosted rung).
const mobileDevice = ref(false);
vi.mock(import(`@intentic/ui`), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useDevice: (() => ({ ...actual.useDevice(), mobile: mobileDevice })) as typeof actual.useDevice,
        // Stubbed without Shiki's async highlighter; tests only check whether the command renders.
        Code: defineComponent({ props: { code: String }, render: () => null }) as unknown as typeof actual.Code,
    };
});

// sandboxes feeds the auto-name count, list is the mount-time read, create is this page's one write.
const sandboxes = ref<SandboxSummary[]>([]);
const list = vi.fn<() => Promise<SandboxSummary[]>>();
const create = vi.fn<(name: string) => Promise<SandboxSummary>>();
const hostedProvision = vi.fn<(sandboxId: string, token: string) => Promise<SandboxSummary>>();
const hostedRelease = vi.fn<(sandboxId: string) => Promise<SandboxSummary>>();
// The 3s poll's read; the wait card is driven entirely by what it returns.
const refresh = vi.fn<() => Promise<SandboxSummary[]>>();
// The discard rule's one observable act: leaving without committing deletes the draft this page minted.
const remove = vi.fn<(id: string) => Promise<void>>();
// The attach lane's one write; named so a test can assert the probe was never even attempted.
const attach = vi.fn<(id: string, url: string) => Promise<void>>();
// activeSandboxId/reachable belong to the chat store, read at module scope; omitting them crashes the import.
vi.mock(`../sandbox/client/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes,
        list,
        create,
        hostedProvision,
        hostedRelease,
        refresh,
        remove,
        select: vi.fn(),
        attach,
        activeSandboxId: ref<string | undefined>(undefined),
        reachable: ref(false),
    }),
}));

// Mint never settles, keeping step 3 locked; hostedOffer defaults to false so classic lanes stay hosted-free.
type Minted = { code: string; hostname: string; expiresAt: string };
const setupCode = vi.fn<() => Promise<Minted>>(() => new Promise<Minted>(() => {}));
const hostedOffer = vi.fn().mockResolvedValue({ enabled: false, remaining: 0 });
// Address minting is on by default; the world every lane below assumes unless a test says otherwise.
const addressOffer = vi.fn().mockResolvedValue({ enabled: true });
// Power poll and restart default harmlessly; a wait that can't ask falls back to its plain step list.
const hostedStatus = vi.fn().mockResolvedValue({ machine: `unknown` });
const hostedRestart = vi.fn().mockResolvedValue({ ok: true });
// The wait's own recovery: the platform is asked to start a machine the provider reports down.
const wake = vi.fn().mockResolvedValue({ ok: true });
vi.mock(`../../lib/useApi`, () => ({ apiClient: { sandbox: { setupCode, hostedOffer, addressOffer, hostedStatus, hostedRestart, wake } } }));
vi.mock(`../sandbox/client/sandboxIdFromToken`, () => ({ sandboxIdFromToken: vi.fn().mockResolvedValue(`0f310c3c4db4`) }));
vi.mock(`../../app/analytics`, () => ({ track: vi.fn() }));
vi.mock(`../auth/useAuth`, () => ({ useAuth: () => ({ user: ref({ email: `owner@example.com` }) }) }));
vi.mock(`../auth/useGoogleIdentity`, () => ({
    useGoogleIdentity: () => ({ getIdToken: vi.fn().mockResolvedValue(`id-token`), warmIdToken: vi.fn() }),
}));
// The page's wall clock as a knob: every verdict the wait card reaches by elapsed time reads this, so a test
// about one has to be able to move it. Frozen at 0 unless a test says otherwise, which is how it behaved before.
const nowAt = ref(0);
vi.mock(`../../../../ui/src/composables/useNow`, () => ({ useNow: () => nowAt }));
vi.mock(`../extensions/useCloudflareZones`, () => ({
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
// Typed off the real export rather than restated, so the knob cannot drift from the function it stands in for.
const desktopInstaller = vi.fn<typeof import("../../app/environments/desktopDownloads").desktopInstaller>(() => undefined);
// Only the four reads that ask something of the machine are stubbed; the rest of the module comes through as
// itself. A listed-exports-only mock made every new export the page reaches for an import-time crash in a file
// that tests none of it (DESKTOP_SETUP_EVENT, which useDesktopSetup subscribes to, arrived exactly that way).
// A browser unless a test sets a version: only the presence of one says "running inside the app", which is the
// arrival that installs on this computer.
const desktopApp = ref<string | undefined>(undefined);
vi.mock(import(`../../app/environments/desktop`), async (importOriginal) => ({
    ...(await importOriginal()),
    desktopSetupLink: () => ``,
    desktopVersion: () => desktopApp.value,
    openDesktopLink: vi.fn(),
}));
vi.mock(import(`../../app/environments/desktopDownloads`), async (importOriginal) => ({
    ...(await importOriginal()),
    desktopInstaller: () => desktopInstaller(),
}));
// Steps 2-3's own components, stubbed out: none of their concerns belong to step 1's tests.
vi.mock(`./SetupCompose.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupHandoff.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupRunDetails.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./SetupSyncOption.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../capabilities/connect/CloudflareTokenField.vue`, () => ({ default: defineComponent({ render: () => null }) }));

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
        providedAddress: false,
        hosted: null,
        ...overrides,
    }) as SandboxSummary;

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Setup) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    // A macrotask flush: the mount's chained awaits (list, then the hosted offer) outrun a fixed tick count.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// Exact label match: substring matching would false-positive on rung prose containing a button's words.
const buttonLabelled = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === text);

// Same question for an <a>: a download is a navigation, so the installer offer is a link, not a button.
const linkLabelled = (text: string): HTMLAnchorElement | undefined =>
    [...document.querySelectorAll(`a`)].find((link) => link.textContent?.trim() === text);

// The leaf holding this exact text, not any ancestor containing it — for asking where something sits.
const nodeWithText = (text: string): Element =>
    [...document.querySelectorAll(`*`)].find((node) => node.children.length === 0 && node.textContent?.trim() === text)!;

// Whether the text follows the picker in document order: what a reader meets before the one choice.
const afterThePicker = (text: string): boolean =>
    (document.querySelector(`[role="radiogroup"]`)!.compareDocumentPosition(nodeWithText(text)) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// A settled mint, so the run card clears its lock; earlier tests leave the mint hanging on purpose.
const MINTED = { code: `vphf-3wk`, hostname: `sandbox-fa0b431303b8.sbx.intentic.dev`, expiresAt: new Date(Date.now() + 600_000).toISOString() };

beforeEach(() => {
    query.value = {};
    nowAt.value = 0;
    wake.mockReset().mockResolvedValue({ ok: true });
    mobileDevice.value = false;
    desktopApp.value = undefined;
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
    attach.mockReset().mockResolvedValue(undefined);
    push.mockReset();
    replace.mockReset();
});

// Moves the faked clock and the page's own reading of it together; `useNow` is mocked, so nothing else moves it.
// Only meaningful under fake timers that include `Date`, which is what the page dates its own waits by.
const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    nowAt.value = Date.now();
};

// Every exit path: the discard rule hangs off unmount, so tests must actually unmount to trigger it.
const leave = (): void => {
    app?.unmount();
    app = undefined;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

it(`creates the sandbox on arrival, with no name asked for`, async () => {
    const el = await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(buttonLabelled(`Create`)).toBeUndefined();
    expect(el.querySelector(`input`)).toBeNull();
    expect([...el.querySelectorAll(`button`)].some((button) => /name/i.test(button.getAttribute(`aria-label`) ?? ``))).toBe(false);
});

// A draft until an act says otherwise: discarding removes the platform row and the mint's tunnel too.
it(`discards the sandbox it made when the reader leaves without committing`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    leave();
    expect(remove).toHaveBeenCalledWith(`new`);
});

// In a browser, arrival itself is the committing act, since a machine now exists behind the row.
it(`keeps the sandbox once a machine has been started for it`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    await mount();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    leave();
    expect(remove).not.toHaveBeenCalled();
});

it(`never discards a sandbox it merely resumed`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    await mount();
    expect(create).not.toHaveBeenCalled();
    leave();
    expect(remove).not.toHaveBeenCalled();
});

it(`says nothing about the sandbox until the arrival read answers`, async () => {
    let answer: (rows: SandboxSummary[]) => void = () => {};
    list.mockReset().mockImplementation(async () => new Promise<SandboxSummary[]>((resolve) => (answer = resolve)));
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Setup) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    expect(buttonLabelled(`Try again`)).toBeUndefined();
    expect(el.textContent).not.toContain(`Connect it by domain`);
    // Once it answers: a row now exists, and its address begins minting.
    answer([]);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    expect(el.textContent).toContain(`Preparing your intentic domain`);
});

it(`numbers the next sandbox instead of colliding with the first`, async () => {
    const existing = sandboxRow({ id: `s1`, name: `workspace`, lastSeenAt: `2026-08-06T00:00:00.000Z` });
    sandboxes.value = [existing];
    list.mockResolvedValue([existing]);
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace-2`);
});

it(`resumes an unfinished sandbox rather than making a second`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    // No "picking up where you left off" messaging yet: nothing has happened to this row since it was minted.
    expect(el.textContent).not.toContain(`Picking up where you left off`);
    expect(el.textContent).not.toContain(`Use a new sandbox instead`);
});

// A reload is the case that matters: `openRow`'s fallback when it recognises no row is to CREATE one, so without the
// id in the URL a reader who got bounced mid-install came back to a second sandbox and a command for neither.
it(`names the sandbox it settled on in the URL, so a reload resumes it instead of making another`, async () => {
    await mount();
    expect(create).toHaveBeenCalledWith(`workspace`);
    expect(replace).toHaveBeenCalledWith({ path: `/setup`, query: { sandbox: `new` } });
});

it(`names a resumed sandbox in the URL too, and leaves the rest of the query alone`, async () => {
    const unfinished = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [unfinished];
    list.mockResolvedValue([unfinished]);
    query.value = { machine: `mine` };
    await mount();
    expect(replace).toHaveBeenCalledWith({ path: `/setup`, query: { machine: `mine`, sandbox: `s1` } });
});

it(`leaves the URL alone when it already names the row being set up`, async () => {
    const named = sandboxRow({ id: `s1`, name: `my-laptop` });
    sandboxes.value = [named];
    list.mockResolvedValue([named]);
    query.value = { sandbox: `s1` };
    await mount();
    expect(replace).not.toHaveBeenCalled();
});

it(`does say where you left off once something has actually happened to the sandbox`, async () => {
    // setupCodeClaimedAt means the command ran somewhere: a real errand in progress, worth an offer to start over.
    const started = sandboxRow({ id: `s1`, name: `my-laptop`, setupCodeClaimedAt: new Date().toISOString() });
    sandboxes.value = [started];
    list.mockResolvedValue([started]);
    const el = await mount();
    expect(el.textContent).toContain(`Picking up where you left off`);
    expect(el.textContent).toContain(`Use a new sandbox instead`);
});

it(`starts a machine of ours for a browser, on arrival`, async () => {
    // Not `…Once`: the page re-reads the allowance every time it spends or hands back a machine.
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    // The row is created the ordinary way: the lane only decides what machine is attached to it.
    expect(create).toHaveBeenCalledWith(`workspace`);
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    await nextTick();
    // The wait names each step rather than a single generic sentence.
    expect(el.textContent).toContain(`Starting the machine`);
    expect(el.textContent).toContain(`Putting it on the internet`);
    // Nothing was asked: no picker on screen, no button to press to begin.
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    expect(buttonLabelled(`Start my machine`)).toBeUndefined();
});

// Only a row this arrival made gets an automatic machine; a found row gets the picker instead.
it(`starts nothing for a sandbox it found rather than made`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const abandoned = sandboxRow({ id: `s1`, name: `workspace` });
    sandboxes.value = [abandoned];
    list.mockResolvedValue([abandoned]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    expect(hostedProvision).not.toHaveBeenCalled();
    // The rung sits on the picker, unchosen — not folded away behind a machine already booting.
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.map((card) => card.getAttribute(`aria-checked`))).toEqual([`false`, `true`]);
    expect(rungs[0]?.textContent).toContain(`Start instantly`);
});

// A full fleet is `full` on the offer, not a thrown error; the rung states it and points at the other lane.
it(`starts nothing, and offers the other rung, when the platform is out of machines`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1, full: true });
    const el = await mount();
    expect(hostedProvision).not.toHaveBeenCalled();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs[0]?.textContent).toContain(`No machines free right now`);
    rungs[0]?.click();
    await nextTick();
    expect(el.textContent).toContain(`We're out of machines right now`);
    // No button that would just fail; the way through is the other rung, plus a later re-read.
    expect(buttonLabelled(`Start my machine`)).toBeUndefined();
    expect(buttonLabelled(`Set it up on my own computer`)?.tagName).toBe(`BUTTON`);
});

// Opening the alternative is just reading it: nothing starts or releases until it's chosen.
it(`offers the rung it did not take, without taking it`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    expect(el.textContent).toContain(`Other ways to set up`);
    buttonLabelled(`Run it on my own computer`)!.click();
    await nextTick();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs).toHaveLength(2);
    expect(rungs.find((card) => card.textContent?.includes(`Start instantly`))?.getAttribute(`aria-checked`)).toBe(`true`);
    expect(hostedRelease).not.toHaveBeenCalled();
});

// Keyed on whether the picker is drawn, not on the arrival itself, so a single-rung platform is covered too.
it(`says what is happening rather than asking, when the arrival answered`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    expect(el.textContent).toContain(`We're starting a machine for you`);
    expect(el.textContent).not.toContain(`Pick where it runs`);
});

it(`asks where it runs only while the picker is on screen`, async () => {
    query.value = { elsewhere: `1` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(2);
    expect(el.textContent).toContain(`Pick where it runs`);
});

// A phone has no way to run a sandbox locally either, so it gets the same automatic machine.
it(`starts a machine for a phone too`, async () => {
    mobileDevice.value = true;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    expect(el.textContent).toContain(`Starting the machine`);
    expect(buttonLabelled(`Start my machine`)).toBeUndefined();
});

// ?machine= outranks the arrival's own decision in both directions: chosen beats automatic either way.
it(`opens on the rung the reader chose before arriving, and starts nothing`, async () => {
    query.value = { machine: `mine` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.find((card) => card.textContent?.includes(`My own computer`))?.getAttribute(`aria-checked`)).toBe(`true`);
    expect(rungs.find((card) => card.textContent?.includes(`Start instantly`))?.getAttribute(`aria-checked`)).toBe(`false`);
    expect(hostedProvision).not.toHaveBeenCalled();
});

// ?machine= also outranks the phone default: reading on a phone about your own desktop is a real case.
it(`lets a chosen rung override the phone default`, async () => {
    query.value = { machine: `mine` };
    mobileDevice.value = true;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs.find((card) => card.textContent?.includes(`My own computer`))?.getAttribute(`aria-checked`)).toBe(`true`);
});

// An unavailable ?machine= is ignored, not honored; with one rung left there's no picker either.
it(`ignores a rung the platform is not offering`, async () => {
    query.value = { machine: `hosted` };
    hostedOffer.mockResolvedValue({ enabled: false, remaining: 0 });
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    await vi.waitFor(() => expect(el.textContent).toContain(`Paste it into a terminal`));
});

// The hostname is a consequence of the chosen rung, so it renders on that rung's own card.
it(`reports the address on the run card rather than above the choice`, async () => {
    // Needs a picker to measure against, so this test picks a rung explicitly (?machine=mine).
    query.value = { machine: `mine` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(MINTED.hostname));
    // Both the address and its escape hatch sit after the picker: a stranger reaches the choice first.
    expect(afterThePicker(MINTED.hostname)).toBe(true);
    expect(afterThePicker(`Use a different address`)).toBe(true);
});

// Leads with the installer wherever one ships; the command stays one labelled click away, not gone.
it(`offers the app first on a machine we ship a build for, with the command one click away`, async () => {
    desktopInstaller.mockReturnValue({ platform: `windows`, label: `Windows`, href: `https://intentic.dev/desktop/windows` });
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(linkLabelled(`Download for Windows`)).toEqual(expect.any(Object)));
    expect(linkLabelled(`Download for Windows`)!.getAttribute(`href`)).toBe(`https://intentic.dev/desktop/windows`);
    // Nothing about a terminal on the first frame, not the paste instruction, not the `sudo` switch.
    expect(el.textContent).not.toContain(`Paste it into a terminal`);
    expect(el.textContent).not.toContain(`I already have Docker`);
    // The wait under it also names the move it's actually waiting on.
    expect(el.textContent).toContain(`Nothing runs until you install the app above`);

    // Alternatives are named on screen, not behind a question; the opener that reveals the command says so.
    expect(el.textContent).toContain(`Other ways to set up`);
    const showCommand = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Show the command`);
    showCommand!.click();
    await nextTick();
    expect(el.textContent).toContain(`Paste it into a terminal`);
});

// No build means no button: a download page with nothing for you is worse than the pipe it replaces.
it(`keeps the command first where there is no build for the reader's machine`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    // The mint watcher debounces by 500ms (Setup.vue `mintTimer`). On a loaded CI runner that real wait
    // plus the async mint can exceed vi.waitFor's default 1s budget, so the clock is walked forward
    // instead. Only setTimeout is faked: mount's own macrotask flush is already past.
    vi.useFakeTimers({ toFake: [`setTimeout`, `clearTimeout`] });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(el.textContent).toContain(`Paste it into a terminal`));
    expect(linkLabelled(`Download for Windows`)).toBeUndefined();
    expect(linkLabelled(`Download for Linux`)).toBeUndefined();
    // No alternatives row here: the command is already the one path on screen.
    expect(el.textContent).not.toContain(`Other ways to set up`);
});

// A refused provision must not strand the run or hide why (spent allowance, capacity, misconfiguration).
it(`keeps the sandbox and says why when the machine is refused`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    hostedProvision.mockRejectedValue(new Error(`no capacity right now`));
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(`no capacity right now`));
    // The row the page made on arrival carries on: not deleted, not made again in another lane.
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    // The way out is the same button, now saying what pressing it would be.
    expect(buttonLabelled(`Try again`)).toEqual(expect.any(Object));
    // Refusal brings the picker back: the reader must answer now, with the working rung beside the reason.
    const rungs = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)];
    expect(rungs).toHaveLength(2);
    expect(rungs.find((card) => card.textContent?.includes(`My own computer`))).toEqual(expect.any(Object));
});

it(`resumes a hosted sandbox onto the wait card, not the command lane`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    const el = await mount();
    expect(create).not.toHaveBeenCalled();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Starting the machine`);
});

// The app's own arrival is this computer. An earlier browser visit can have left a machine on the same unfinished
// row, and adopting it made the app greet its owner with someone else's answer and a machine already booting.
it(`hands back an untouched machine on arrival in the app, and mints a code for this computer`, async () => {
    desktopApp.value = `1.275.0`;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    const el = await mount();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`h1`));
    // The row is kept and nothing is started in its place: the machine is given back, not replaced.
    expect(create).not.toHaveBeenCalled();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Starting the machine`);
    // The proof the local lane is live: while a machine sits on the row, no setup code is ever minted.
    await vi.waitFor(() => expect(setupCode).toHaveBeenCalledWith({ sandboxId: `h1` }));
});

// Handing a machine back is safe only while nothing has run on it; a redeemed code means work no one may lose.
it(`keeps a machine the app finds mid-errand, and asks instead`, async () => {
    desktopApp.value = `1.275.0`;
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const hosted = sandboxRow({
        id: `h1`,
        name: `mine`,
        hosted: { region: `iad`, warm: false },
        setupCodeClaimedAt: new Date().toISOString(),
    });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    const el = await mount();
    expect(hostedRelease).not.toHaveBeenCalled();
    expect(setupCode).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Starting the machine`);
});

// A refused check-in means alive but turned away, not slow to boot; waiting alone can't fix it, so the card must say so
// and offer a way out.
it(`names a refused check-in on the wait card, with a way out`, async () => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: false } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    refresh.mockResolvedValue([{ ...hosted, announceRefusal: { announced: `old.example.dev`, expected: `sandbox-abc.sbx.test` } }]);
    // The poll is what learns this: the row the page was mounted with knew nothing. It runs every 3s, and the
    // clock is walked to that tick rather than waited on. Only the interval is faked: the mount's own macrotask
    // flush and vi.waitFor's polling stay on real time.
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(el.textContent).toContain(`old.example.dev`));
    expect(el.textContent).toContain(`sandbox-abc.sbx.test`);
    // The step list disappears here: a ticking list beside a failure message would contradict it.
    expect(el.textContent).not.toContain(`Putting it on the internet`);

    // The address is built into this machine, so the way out is a new one rather than another boot.
    const restart = [...el.querySelectorAll<HTMLElement>(`button`)].find((button) => button.textContent?.includes(`Start it over`));
    restart!.click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`h1`));
    expect(hostedProvision).toHaveBeenCalledWith(`h1`, `tok`);
    expect(hostedRestart).not.toHaveBeenCalled();
});

/* THE BUTTON THIS PAGE USED TO HAND PEOPLE INSTEAD OF PRESSING IT ITSELF. A hosted machine stops for ordinary
 * reasons while nobody is in it — the daemon's idle-stop, a first boot the provider gave up restarting, a machine
 * still stopped from the last visit — and every one of them ended this wait with "the machine we started for you
 * isn't running" over a button whose only reader was the person least able to know that. */
const hostedWaiting = (): SandboxSummary => {
    const hosted = sandboxRow({ id: `h1`, name: `mine`, hosted: { region: `iad`, warm: true } });
    sandboxes.value = [hosted];
    list.mockResolvedValue([hosted]);
    refresh.mockResolvedValue([hosted]);
    return hosted;
};

it(`starts a machine the provider says is down, instead of asking the reader to`, async () => {
    hostedWaiting();
    hostedStatus.mockResolvedValue({ machine: `stopped` });
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith({ sandboxId: `h1` }));
    // And keeps narrating a boot, because a boot is exactly what that just started.
    expect(el.textContent).toContain(`Starting the machine`);
    expect(el.textContent).not.toContain(`isn't running`);
    expect(buttonLabelled(`Start it over`)).toBeUndefined();
});

// Bounded, and honest once the bound is spent: a machine that will not stay up must not be restarted forever on
// hours its owner is charged for, and a page that has stopped trying owes the reader the button and the truth.
it(`stops starting a machine that will not stay up, and then says so`, async () => {
    hostedWaiting();
    hostedStatus.mockResolvedValue({ machine: `stopped` });
    // Date rides the fake clock here: the reflex throttles itself by wall time, and the card's verdict is a
    // reading of it, so a test about either has to own it.
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`, `Date`] });
    const el = await mount();
    // Machine state is read every fourth 3s poll, and starts are 30s apart: three of them fit in a minute and a
    // half, and nothing buys a fourth.
    await tick(90_000);
    expect(wake).toHaveBeenCalledTimes(3);
    await tick(90_000);
    expect(wake).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(el.textContent).toContain(`isn't running`));
    // And the button is the reader's now: the heavier recovery this page never attempts on anyone's behalf.
    buttonLabelled(`Start it over`)!.click();
    await vi.waitFor(() => expect(hostedRestart).toHaveBeenCalledWith({ sandboxId: `h1` }));
});

// The one wording a reader can prove wrong: "that's ours to fix, nothing on your side causes this", said over a
// machine the platform is deliberately keeping down, with a button under it that earns a second refusal.
it(`says what a refused start actually was, and offers the way out that works`, async () => {
    hostedWaiting();
    hostedStatus.mockResolvedValue({ machine: `stopped` });
    wake.mockRejectedValue(Object.assign(new Error(`free hours are used up this month`), { code: `PAYMENT_REQUIRED`, status: 402 }));
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(3_000);
    // No clock is waited out for this: somebody decided it, so it is true the moment it is known.
    await vi.waitFor(() => expect(el.textContent).toContain(`free hours`));
    expect(el.textContent).not.toContain(`isn't running`);
    expect(buttonLabelled(`Start it over`)).toBeUndefined();
    // The offered way out is the one that works right now, and taking it hands the stopped machine back.
    buttonLabelled(`Set it up on my own computer`)!.click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`h1`));
});

// A switch moves the machine, never the sandbox: same id, same name, no delete-and-recreate.
it(`offers the rungs as readable cards, each stating its trade`, async () => {
    // ?elsewhere=1: the desktop app's escape hatch; shows the picker without starting anything automatically.
    query.value = { elsewhere: `1` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    expect(hostedProvision).not.toHaveBeenCalled();
    const cards = [...el.querySelectorAll(`[role="radio"]`)];
    expect(cards).toHaveLength(2);
    // Not a bare label each: the cost and what it asks of you are on the card, before it is clicked.
    expect(cards[0]?.textContent).toContain(`Start instantly`);
    expect(cards[0]?.textContent).toContain(`Free`);
    // Whose machine the instant one is stays on the card: the title sells the speed, the note says where it runs.
    expect(cards[0]?.textContent).toContain(`Runs on our servers`);
    expect(cards[1]?.textContent).toContain(`One pasted command`);
    // What the reader's own machine wins over the free one, stated where the choice is made, not discovered later.
    expect(cards[1]?.textContent).toContain(`no limits`);
});

// Ceiling and what follows show on the card; the small print follows selection, not both rungs upfront.
it(`states the hour ceiling and what follows it on the hosted card, with the small print beside the button`, async () => {
    query.value = { elsewhere: `1` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1, hours: { allowance: 40, remaining: 40 } });
    const el = await mount();
    const hosted = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)][0];
    expect(hosted?.textContent).toContain(`40h a month, always on with the plan`);
    hosted!.click();
    await nextTick();
    // Card stays three lines; the disk's fate is read where the reader commits, not on the card itself.
    expect(hosted?.textContent).not.toContain(`back it up`);
    expect(el.textContent).toContain(`don't back it up`);
    expect(el.textContent).toContain(`it's removed`);
});

// Bare "Free · ready in seconds" is reserved for a platform with no ceiling at all.
it(`says always on, not free, on the hosted card of an owner on the plan`, async () => {
    query.value = { elsewhere: `1` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1, plan: true });
    const el = await mount();
    const hosted = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)][0];
    expect(hosted?.textContent).toContain(`On your plan · always on`);
    expect(hosted?.textContent).not.toContain(`Free`);
});

it(`says nothing about hours to someone they do not apply to`, async () => {
    query.value = { elsewhere: `1` };
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    const hosted = [...el.querySelectorAll(`[role="radio"]`)][0];
    expect(hosted?.textContent).toContain(`ready in seconds`);
    expect(hosted?.textContent).not.toContain(`a month`);
    expect(hosted?.textContent).not.toContain(`we remove it`);
});

it(`hands the machine back when another rung is chosen, keeping the same sandbox`, async () => {
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    // The arrival started it; the reader opens the rung it did not take and steps off.
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    buttonLabelled(`Run it on my own computer`)!.click();
    await nextTick();
    const mine = (): HTMLButtonElement =>
        [...el.querySelectorAll(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`)) as HTMLButtonElement;
    // Rungs disable while the machine is made and the allowance re-read; clicking before that settles does nothing.
    await vi.waitFor(() => expect(mine().disabled).toBe(false));
    mine().click();
    await vi.waitFor(() => expect(hostedRelease).toHaveBeenCalledWith(`new`));
    expect(create).toHaveBeenCalledTimes(1); // the row survived the switch
    expect(remove).not.toHaveBeenCalled();
});

// Allowance is the server's live machine count; it must be re-read after release, not just on arrival.
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

it(`switches during provisioning and ignores the machine's late response`, async () => {
    const provisioning = Promise.withResolvers<SandboxSummary>();
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    hostedProvision.mockReturnValue(provisioning.promise);
    hostedRelease.mockResolvedValue(sandboxRow({ id: `new`, token: `local-token` }));
    const el = await mount();
    buttonLabelled(`Run it on my own computer`)!.click();
    await nextTick();
    const mine = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`))!;
    expect(mine.disabled).toBe(false);
    mine.click();
    await vi.waitFor(() => expect(mine.getAttribute(`aria-checked`)).toBe(`true`));
    expect(hostedRelease).toHaveBeenCalledExactlyOnceWith(`new`);
    await vi.waitFor(() => expect(setupCode).toHaveBeenCalledWith({ sandboxId: `new` }));
    provisioning.resolve(sandboxRow({ id: `new`, hosted: { region: `iad`, warm: true }, lastSeenAt: new Date().toISOString() }));
    await nextTick();
    await nextTick();
    expect(mine.getAttribute(`aria-checked`)).toBe(`true`);
    expect(el.textContent).not.toContain(`Starting the machine`);
    expect(push).not.toHaveBeenCalled();
});

it(`can retry cancellation while the provision request is still pending`, async () => {
    const provisioning = Promise.withResolvers<SandboxSummary>();
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    hostedProvision.mockReturnValue(provisioning.promise);
    hostedRelease.mockRejectedValueOnce(new Error(`network`)).mockResolvedValue(sandboxRow({ id: `new`, token: `local-token` }));
    const el = await mount();
    buttonLabelled(`Run it on my own computer`)!.click();
    await nextTick();
    const mine = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`))!;
    mine.click();
    await vi.waitFor(() => expect(el.textContent).toContain(`Couldn't remove the machine`));
    mine.click();
    await vi.waitFor(() => expect(mine.getAttribute(`aria-checked`)).toBe(`true`));
    expect(hostedRelease).toHaveBeenCalledTimes(2);
    provisioning.reject(new Error(`cancelled`));
    await nextTick();
    expect(el.textContent).not.toContain(`Couldn't start a machine`);
});

it(`ignores a ready hosted poll returned after switching to the local install`, async () => {
    vi.useFakeTimers({ toFake: [`setInterval`, `clearInterval`] });
    const hosted = sandboxRow({ id: `h1`, hosted: { region: `iad`, warm: true } });
    list.mockResolvedValue([hosted]);
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 0 });
    const poll = Promise.withResolvers<SandboxSummary[]>();
    refresh.mockReturnValue(poll.promise);
    hostedRelease.mockResolvedValue(sandboxRow({ id: `h1`, token: `local-token` }));
    const el = await mount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const mine = [...el.querySelectorAll<HTMLButtonElement>(`[role="radio"]`)].find((card) => card.textContent?.includes(`My own computer`))!;
    mine.click();
    await vi.waitFor(() => expect(mine.getAttribute(`aria-checked`)).toBe(`true`));
    poll.resolve([{ ...hosted, lastSeenAt: new Date().toISOString(), bootReport: { reach: `reachable`, at: new Date().toISOString() } }]);
    await nextTick();
    await nextTick();
    expect(push).not.toHaveBeenCalled();
    expect(mine.getAttribute(`aria-checked`)).toBe(`true`);
});

// A 404 on the mint means nothing is offered; say so immediately rather than flashing rungs that can't work.
it(`states what an addressless platform can do, without spinning and without opening a form`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    const el = await mount();
    // Not asked for: the code the platform has already said it will not mint.
    expect(setupCode).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(`Preparing your intentic domain`);
    // No rungs to retract: the ladder was never drawn since there was only ever one thing on offer.
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    // The fact, stated as a fact about the deployment.
    expect(el.textContent).toContain(`doesn't start sandboxes or hand out addresses`);
    // Never auto-switches to the attach lane; it stays one labelled click away.
    expect(el.textContent).not.toContain(`Connect your sandbox`);
    expect(el.textContent).toContain(`Already running a sandbox somewhere?`);
});

// This form connects a sandbox the reader already serves. Our own hostname in it can only probe `unreachable`, which
// reads as a verdict about their DNS: the observed failure was ten presses of Connect against the same red box.
it(`refuses to probe an address we handed out, and points back at the command`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(MINTED.hostname));
    buttonLabelled(`Use a different address`)!.click();
    await nextTick();
    buttonLabelled(`a domain it already answers on`)!.click();
    await nextTick();

    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = MINTED.hostname;
    field.dispatchEvent(new Event(`input`));
    await nextTick();

    expect(el.textContent).toContain(`That address is ours`);
    expect(el.textContent).toContain(`run the install command instead`);
    // Not merely explained: pressing it anyway is the loop this closes.
    expect(buttonLabelled(`Connect`)?.disabled).toBe(true);
    expect(attach).not.toHaveBeenCalled();
});

// WEB_ORIGIN is a variable from a script most readers never ran. Printed as the second thing to check it reads as a
// third fault; folded, the two checks anyone can actually make come first.
it(`folds the WEB_ORIGIN cause away until the checks anyone can make have been tried`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(MINTED.hostname));
    buttonLabelled(`Use a different address`)!.click();
    await nextTick();
    buttonLabelled(`a domain it already answers on`)!.click();
    await nextTick();

    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = `sandbox.example.com`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    // Nothing is listening in a unit run, so the probe's own verdict is the `unreachable` this notice is for.
    buttonLabelled(`Connect`)!.click();
    await vi.waitFor(() => expect(el.textContent).toContain(`Nothing answered at that address.`));

    expect(el.textContent).toContain(`Check the sandbox is running`);
    expect(el.textContent).not.toContain(`WEB_ORIGIN`);

    buttonLabelled(`Checked both, still nothing?`)!.click();
    await nextTick();
    expect(el.textContent).toContain(`WEB_ORIGIN`);
});

it(`still attaches a domain of the reader's own`, async () => {
    setupCode.mockResolvedValue(MINTED);
    const el = await mount();
    await vi.waitFor(() => expect(el.textContent).toContain(MINTED.hostname));
    buttonLabelled(`Use a different address`)!.click();
    await nextTick();
    buttonLabelled(`a domain it already answers on`)!.click();
    await nextTick();

    const field = el.querySelector<HTMLInputElement>(`input`)!;
    field.value = `sandbox.example.com`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();

    expect(el.textContent).not.toContain(`That address is ours`);
    expect(buttonLabelled(`Connect`)?.disabled).toBe(false);
});

// A failed read isn't proof of "provisions nothing"; that verdict needs an actual answer, not silence.
it(`offers a retry, not a verdict, when the offers could not be read at all`, async () => {
    addressOffer.mockRejectedValueOnce(new Error(`network`));
    hostedOffer.mockRejectedValueOnce(new Error(`network`));
    const el = await mount();
    expect(el.textContent).toContain(`couldn't reach the platform`);
    expect(el.textContent).not.toContain(`doesn't start sandboxes`);
    expect(el.textContent).not.toContain(`Connect your sandbox`);
    expect(buttonLabelled(`Try again`)?.disabled).toBe(false);
});

// A 404, unlike a dropped request, really does mean the platform provisions nothing.
it(`treats a missing offer route as an answer rather than a lost read`, async () => {
    addressOffer.mockRejectedValueOnce(Object.assign(new Error(`nope`), { code: `NOT_FOUND` }));
    hostedOffer.mockRejectedValueOnce(Object.assign(new Error(`nope`), { code: `NOT_FOUND` }));
    const el = await mount();
    expect(el.textContent).toContain(`doesn't start sandboxes or hand out addresses`);
    expect(el.textContent).not.toContain(`couldn't reach the platform`);
});

// Hosted machines are born holding their own tunnel, so this lane needs no mint at all.
it(`keeps the hosted lane when the platform hosts but mints no addresses`, async () => {
    addressOffer.mockResolvedValue({ enabled: false });
    hostedOffer.mockResolvedValue({ enabled: true, remaining: 1 });
    const el = await mount();
    await vi.waitFor(() => expect(hostedProvision).toHaveBeenCalledWith(`new`, `tok`));
    expect(el.textContent).toContain(`Starting the machine`);
    expect(el.textContent).not.toContain(`Connect your sandbox`);
    expect(el.querySelectorAll(`[role="radio"]`)).toHaveLength(0);
    // Nothing points at the rung this platform can't deliver: there's no command to paste.
    expect(el.textContent).not.toContain(`Other ways to set up`);
});

// A spent allowance gets its own message, not the addressless one: the machine exists, it's just busy elsewhere.
it(`names the spent allowance instead of a missing fabric`, async () => {
    addressOffer.mockResolvedValueOnce({ enabled: false });
    hostedOffer.mockResolvedValueOnce({ enabled: true, remaining: 0 });
    const el = await mount();
    expect(hostedProvision).not.toHaveBeenCalled();
    expect(setupCode).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`already running another sandbox`);
    // Not the wrong diagnosis: this platform hosts perfectly well, it is the allowance that is spent.
    expect(el.textContent).not.toContain(`doesn't start sandboxes`);
    expect(el.textContent).not.toContain(`Connect your sandbox`);
});
