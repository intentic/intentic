// @vitest-environment jsdom
//
// jsdom because the subject is WHAT A ROW SAYS. The tab drew a name, a reach and a badge, so a Windows laptop and
// a Linux desktop with no sync agent on either rendered as two identical lines, and the pair of rows in the
// report that prompted this were the same machine twice over. What is worth pinning is therefore not the
// derivation (computerFacts.test.ts has that) but that the row actually PUTS it on screen, next to the name, for a
// computer that has nothing else to show.
import type { Computer } from "@intentic/sandbox-contract";
import { DESTRUCTIVE_VERB, groupNeedsAttention, groupSummary, menuVerbs, primaryVerb, sandboxGroups } from "@intentic/ui";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the daemon client) and a media
// query (the UI barrel's useDevice). jsdom plus these two is the whole of it: see daemonRestart.test.ts, which
// cuts the same edge.

const computers = ref<Computer[]>([]);
// The FIRST read, not the ten-second poll. Every test below is about a list that has already arrived, so this
// stays false for them; the pair at the bottom drives it to pin what the tab may say before it has.
const computersLoading = ref(false);
/* THE MACHINE'S OWN CLI, RUN FROM A BUTTON, recorded rather than performed. The real one POSTs to the daemon,
 * which runs `intentic-machine sync mirror off` over the computer connection; what is worth pinning on this side
 * is the three things the button decides: that it is offered at all, which way it points, and that what leaves
 * here names the row's OWN sandbox rather than every pairing on that machine. */
const mirrorCalls: { hostId: string; command: string; sandboxId?: string | undefined }[] = [];
// What the machine answers. `ok: false` is a machine explaining itself (its "Run commands" switch is off, its
// CLI exited non-zero) and reaches the row as words rather than as a throw, so a test can swap this and pin it.
let mirrorAnswer: { ok: boolean; message: string } = { ok: true, message: `Port mirroring OFF for: work-abc` };
vi.mock(`../../composables/sandbox/useComputers`, async () => {
    // reportStale is a plain function of the row and the clock: real, so a row's staleness line is decided the
    // way it is in the app rather than by this file's idea of it.
    const real = await import(`../../composables/sandbox/useComputers`);
    return {
        ...real,
        useComputers: () => ({ computers, error: ref(undefined), isLoading: computersLoading, refetch: () => {} }),
        runMachineCommand: (hostId: string, command: string, sandboxId?: string) => {
            mirrorCalls.push({ hostId, command, sandboxId });
            return Promise.resolve(mirrorAnswer);
        },
    };
});
// `sandboxKey` is reached at module eval by the real useComputers above, which is why it is here as well as the
// one hook the component calls.
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ daemonUrl: ref(undefined) }),
    sandboxKey: (name: string) => [name],
}));
/* The release this sandbox knows about. Mocked rather than left to the real /info query for the same reason
 * useComputers is: the subject is what a ROW says, and an agent's staleness is now part of that. A ref so a test
 * can set it to undefined and pin the case where the yardstick is missing. */
const latest = ref<string | undefined>(`1.183.0`);
vi.mock(`../../composables/sandbox/useSandboxVersion`, () => ({ useSandboxVersion: () => ({ latest }) }));
/* The owner's switches for each connected computer, which the row now reads so it can say "Manage sandboxes is
 * off" BEFORE a click rather than after the machine refuses one. Mocked because the real hook reaches for
 * vue-query's injected client, which this bare `createApp` has no plugin to provide. */
const capabilities = ref<{ id: string; config: Record<string, string> }[]>([]);
vi.mock(`../../composables/extensions/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities }) }));
// The two cards below the list have their own daemon calls; this mounts the list and nothing else.
vi.mock(`./DesktopSyncCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./BridgeTokensCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// A blocked machine's "open its permissions" is a link now, so the mock carries a stand-in for it.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ query: {} }) as never,
    useRouter: () => ({ push: () => {} }) as never,
    RouterLink: (await import(`../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

/* HOW MANY TIMES THE LIST RE-DERIVES ITSELF, counted through the one function every derivation of a row passes
 * through. `watcherStalled` is called from `rows` (once per machine) and from `tone`/`label` (again per machine,
 * and again per comparison the sort makes), so its call count is a direct read on whether the whole chain,
 * sandboxGroups included, has run. See the tick test at the bottom for why that is worth pinning. */
let derivations = 0;
vi.mock(import(`@intentic/sandbox-contract`), async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        watcherStalled: ((...args: Parameters<typeof real.watcherStalled>) => {
            derivations += 1;
            return real.watcherStalled(...args);
        }) as never,
    };
});

/* THIS SANDBOX'S RUNNERS ON A MACHINE, mocked for the reason the computers list is: the real hook is a
 * vue-query read, and this bare `createApp` has no plugin to provide a client. What the row draws from it is
 * the subject here. */
const runnersList = ref<{ id: string; host?: string; online: boolean; parity?: string; facts?: { cpus: number; memoryMb: number; load: number } }[]>(
    [],
);
vi.mock(`../../composables/sandbox/useRunners`, () => ({
    useRunners: () => ({ runners: runnersList, ready: runnersList, isLoading: ref(false), refetch: () => {} }),
    createRunner: () => Promise.resolve(`made`),
    removeRunner: () => Promise.resolve(`removed`),
    forgetRunner: () => Promise.resolve(),
}));

const { default: SandboxComputers } = await import("./SandboxComputers.vue");

let app: App | undefined;
const mount = (rows: Computer[]): HTMLElement => {
    computers.value = rows;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxComputers) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

/* UNFOLDING A ROW. Both a computer and a sandbox are drawn as one line with a disclosure over the whole of it:
 * the name IS the button, so a test opens one the way a reader does: by pressing the line that says its name. */
const disclosures = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>(`button[aria-expanded]`)];
const openRow = async (el: HTMLElement, name: string): Promise<void> => {
    disclosures(el)
        .find((button) => (button.textContent ?? ``).includes(name))
        ?.click();
    await nextTick();
};

afterEach(() => {
    latest.value = `1.183.0`;
    runnersList.value = [];
    computersLoading.value = false;
    capabilities.value = [];
    mirrorCalls.length = 0;
    mirrorAnswer = { ok: true, message: `Port mirroring OFF for: work-abc` };
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    // The app's clock is a module singleton, so a test that faked time hands the next one a frozen one.
    vi.useRealTimers();
});

/* The row from the report: a connected computer, reachable, with no sync agent on it, so no report, and before
 * this nothing but its name. Everything asserted here was already known to the daemon while the row said none of
 * it. */
it(`says what a computer is when it has no report to show`, () => {
    const el = mount([
        {
            key: `radarsu-rog`,
            label: `radarsu-rog`,
            syncEnrolled: false,
            hostId: `radarsu-rog`,
            online: true,
            platform: `windows`,
            facts: {
                os: `Windows 11 Pro (build 10.0.26100)`,
                arch: `x64`,
                shell: `PowerShell 7`,
                home: `C:\\Users\\ada`,
                roots: [`C:\\Users\\ada`],
            },
            hostAgent: `0.5.1`,
            gap: `no-agent`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Windows 11 Pro`);
    expect(text).toContain(`x64`);
    expect(text).toContain(`PowerShell 7`);
    // The gap it had before is still said, because the OS does not answer it: this machine still has no agent.
    expect(text).toContain(`no sync agent`);
});

// A machine that never described itself still has to answer "Windows or Linux?": the card it was added with says
// so, and that is true from the moment it is added and while it is asleep.
it(`falls back to the platform, and ages a computer that is not here`, () => {
    const el = mount([
        {
            key: `linux`,
            label: `linux`,
            syncEnrolled: false,
            hostId: `linux`,
            online: false,
            platform: `linux`,
            lastSeen: Date.now() - 3 * 60 * 60_000,
            gap: `offline`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Linux`);
    expect(text).toContain(`last seen 3h ago`);
});

/* Sorting by name alone buried the one machine worth reading. The names here are chosen so that alphabetical
 * order is the exact opposite of the order that helps: a reader arriving at this tab wants the computer actually
 * serving folders and ports, not three screens of "nothing to read from it right now" above it. */
it(`puts the machines worth reading first`, () => {
    const report = (capturedAt: number): Computer[`report`] => ({
        hostname: `host`,
        os: `linux`,
        agents: { sync: `0.1.0` },
        sandboxes: [],
        pairings: [],
        ports: [],
        watcher: { running: true },
        capturedAt,
    });
    const el = mount([
        { key: `a`, label: `a-offline`, syncEnrolled: false, hostId: `a`, online: false, platform: `linux`, gap: `offline` },
        { key: `b`, label: `b-quiet`, syncEnrolled: true, platform: `linux`, report: report(Date.now() - 60 * 60_000) },
        { key: `c`, label: `c-attention`, syncEnrolled: false, hostId: `c`, online: true, platform: `linux`, gap: `no-agent` },
        { key: `d`, label: `d-live`, syncEnrolled: true, platform: `linux`, report: report(Date.now()) },
    ]);
    const text = el.textContent ?? ``;
    const at = (label: string): number => text.indexOf(label);
    expect(at(`d-live`)).toBeLessThan(at(`c-attention`));
    expect(at(`c-attention`)).toBeLessThan(at(`b-quiet`));
    expect(at(`b-quiet`)).toBeLessThan(at(`a-offline`));
});

/* The image is what Update changes, and one sandbox on a machine running something older than its neighbour was
 * invisible on a list that named only the container. It is now BEHIND the fold: the longest string on the row
 * and the least often read, so this pins that opening the row still reaches it. */
it(`names the image each sandbox on the machine is running, once the row is open`, async () => {
    const el = mount([
        {
            key: `laptop`,
            label: `laptop`,
            syncEnrolled: true,
            platform: `linux`,
            report: {
                hostname: `laptop`,
                os: `linux`,
                agents: { sync: `0.1.0` },
                sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1` }],
                pairings: [],
                ports: [],
                watcher: { running: true },
                capturedAt: Date.now(),
            },
        },
    ]);
    expect(el.textContent ?? ``).not.toContain(`ghcr.io/intentic/sandbox:2.3.1`);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`ghcr.io/intentic/sandbox:2.3.1`);
});

/* THE VERB ROW, WHICH IS NOW ONE ROW FOR TWO APPS. This tab and the desktop app's manager window drive the same
 * containers on the same machine and had grown different sets of buttons: this one had Restart and no log tail,
 * that one a log tail and no Restart, and neither offered the rollback both of their backends could already do.
 * The buttons come from the kit now (<SandboxVerbs>), so what is asserted here is what a reader of EITHER app
 * gets: pinned from this side because it is the side with a test runner, and it is the same component.
 *
 * A manageable row is a machine this sandbox can reach right now (`hostId`, `online`) whose group has a
 * container: the three conditions `manageable` names. */
const managed = (running: boolean): Computer => ({
    key: `laptop`,
    label: `laptop`,
    syncEnrolled: true,
    platform: `linux`,
    hostId: `host-1`,
    online: true,
    report: {
        hostname: `laptop`,
        os: `linux`,
        agents: { sync: `1.183.0` },
        sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running, image: `ghcr.io/intentic/sandbox:2.3.1` }],
        pairings: [],
        ports: [],
        watcher: { running: true },
        capturedAt: Date.now(),
    },
});

/* Every control a row offers, by its label: anchors as well as buttons, because a control that GOES somewhere
 * is a link: the fix for a blocked machine is the capability card's own address, so it is hoverable, copyable
 * and Ctrl/⌘-clickable rather than a button that moves this tab. */
const labels = (el: HTMLElement): string[] => [...el.querySelectorAll(`button, a`)].map((control) => control.textContent?.trim() ?? ``);

// Every switch granted: the state a row reaches once its computer is connected AND permitted, which is what the
// verb tests below are about. Without it the row correctly says which grant is missing instead.
const granted = (): void => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on`, sandboxes: `on`, sandboxRemove: `on` } }];
};

/* ONE BUTTON ON THE ROW, AND THE REST BEHIND A MENU. All six used to sit on the line: four sandboxes on one
 * machine meant twenty-four controls in one weight, and the row's own NAME (the thing anybody scans for) was
 * the quietest object on the line it titled. The power verb is what people reach for, so it is what stays. */
it(`puts one verb on the row and everything else behind a menu`, () => {
    granted();
    const el = mount([managed(true)]);
    const found = labels(el);
    expect(found).toContain(`Stop`);
    // The overflow is a glyph, so it is named for assistive tech rather than in words on the row.
    expect(el.querySelector(`button[aria-label="More actions"]`)).not.toBeNull();
    // The other five are one deliberate click away rather than sitting on the line.
    for (const verb of [`Restart`, `Update`, `Roll back`, `Logs`, `Remove`]) {
        expect(found).not.toContain(verb);
    }
});

// Start replaces Stop rather than joining it: a stopped sandbox has nothing to stop, and a running one is not
// started twice.
it(`offers Start, and no Stop, on a sandbox that is not running`, () => {
    granted();
    const found = labels(mount([managed(false)]));
    expect(found).toContain(`Start`);
    expect(found).not.toContain(`Stop`);
});

/* WHAT IS IN THAT MENU, pinned as vocabulary rather than through PrimeVue's teleported overlay: the model is
 * what both apps read, and asserting it here is what stops the desktop window and this tab drifting into two
 * different sets again: the failure the shared kit exists to prevent.
 *
 * Restart is absent on a stopped sandbox for the same reason Stop is; removal is separate from the rest because
 * it is the one thing here that nothing undoes, and the row draws it under a divider. */
it(`keeps the menu's vocabulary the same for both apps`, () => {
    expect(primaryVerb(true)).toBe(`stop`);
    expect(primaryVerb(false)).toBe(`start`);
    expect(menuVerbs(true)).toEqual([`restart`, `logs`, `update`, `rollback`]);
    expect(menuVerbs(false)).toEqual([`logs`, `update`, `rollback`]);
    expect(DESTRUCTIVE_VERB).toBe(`remove`);
});

// A fully connected and permitted machine says nothing at all about connecting or permissions: the whole point
// of the three lines below is that they are absent once there is nothing in the way.
it(`says nothing about connecting a computer that is already managing its sandboxes`, () => {
    granted();
    const text = mount([managed(true)]).textContent ?? ``;
    expect(text).not.toContain(`Connect it as a computer`);
    expect(text).not.toContain(`Manage sandboxes on this computer`);
    expect(text).not.toContain(`Remove sandboxes from this computer`);
});

/* THE ROW THE PARITY COMPLAINT WAS ABOUT. A machine paired by the desktop app is enrolled for desktop sync
 * alone, and that door never reports containers, so this tab drew folders and ports and an empty sandbox list
 * with no buttons on it, beside a desktop window managing those very containers. It said none of that, and
 * offered nothing. Now it says both, and the button goes to the card that closes the gap. */
const syncOnly = (): Computer => ({
    key: `laptop`,
    label: `laptop`,
    syncEnrolled: true,
    platform: `windows`,
    report: {
        hostname: `laptop`,
        os: `win32`,
        agents: { sync: `1.183.0` },
        // Empty because the sync agent never fills it: the fact this whole message exists to explain.
        sandboxes: [],
        pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `C:\\Users\\ada\\work`, mutagenStatus: `watching` }],
        ports: [],
        watcher: { running: true },
        capturedAt: Date.now(),
    },
});

it(`explains why a sync-only computer has no sandbox buttons, and offers the fix`, () => {
    const el = mount([syncOnly()]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Desktop sync carries folders and ports, never containers`);
    expect(labels(el)).toContain(`Connect this computer`);
    // No verbs, because there is no container to aim one at: the state being explained, not worked around.
    expect(labels(el)).not.toContain(`Restart`);
});

// A Mac is the hole this leaves: there is no card to connect one as a computer, so the sentence still runs and
// the button that would point nowhere does not.
it(`explains the gap without a button when there is no card to connect the machine`, () => {
    const el = mount([{ ...syncOnly(), platform: `macos` }]);
    expect(el.textContent ?? ``).toContain(`Desktop sync carries folders and ports, never containers`);
    expect(labels(el)).not.toContain(`Connect this computer`);
});

/* CONNECTED, AND STILL REFUSED. "Run commands" is enough to LIST a machine's containers, so the buttons appeared
 * on a row where every one of them would be turned down by the machine: a no the page could see coming and
 * said nothing about until it had already been clicked. */
it(`names the switch a connected computer is missing before anything is clicked`, () => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on` } }];
    const el = mount([managed(true)]);
    expect(el.textContent ?? ``).toContain(`Manage sandboxes on this computer`);
    expect(labels(el)).toContain(`Open its permissions`);
});

// Removal has a grant of its own, because nothing undoes it. A machine that can do everything else still says
// which single button will not work.
it(`names the removal switch on a machine that may do everything else`, () => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on`, sandboxes: `on` } }];
    const text = mount([managed(true)]).textContent ?? ``;
    expect(text).toContain(`Remove sandboxes from this computer`);
    expect(text).not.toContain(`Turn on "Manage sandboxes on this computer"`);
});

/* --- FOLDING, AND WHAT A FOLDED LINE STILL HAS TO ANSWER ---------------------------------------------------
 *
 * The view drew every fact about every sandbox at once: one laptop with four of them filled the screen, and
 * three machines was a page nobody could scan. Folding is only an improvement if the closed line still answers
 * "is this one fine", so these pin both halves: what disappears, and what must not. */
const busyMachine = (): Computer => ({
    key: `rog`,
    label: `radarsu-rog`,
    syncEnrolled: true,
    platform: `linux`,
    hostId: `host-1`,
    online: true,
    report: {
        hostname: `radarsu-rog`,
        os: `linux`,
        agents: { sync: `1.183.0` },
        sandboxes: [
            { slug: `sandbox-bce57bb9fe3b`, container: `c1`, running: true, image: `img:a` },
            { slug: `sandbox-0738cd6b5027`, container: `c2`, running: true, image: `img:b` },
            { slug: `sandbox-4c64429cade7`, container: `c3`, running: false, image: `img:c` },
        ],
        pairings: [
            { sandboxId: `sandbox-bce57bb9fe3b`, mode: `sync`, localDir: `/home/radarsu/intentic/radarsu-web-platform-bce57bb9fe3b` },
            { sandboxId: `sandbox-0738cd6b5027`, mode: `sync`, localDir: `/home/radarsu/intentic/radarsu-local-0738cd6b5027` },
        ],
        ports: [
            { port: 8788, host: `127.0.0.1`, sandboxId: `sandbox-bce57bb9fe3b`, state: `mirrored` },
            { port: 33177, host: `127.0.0.1`, sandboxId: `sandbox-bce57bb9fe3b`, state: `mirrored` },
            { port: 5440, host: `127.0.0.1`, sandboxId: `sandbox-0738cd6b5027`, state: `busy` },
        ],
        watcher: { running: true },
        capturedAt: Date.now(),
    },
});

/* THE NAME. Three sandboxes on this machine differ only by a blob of hex, and the readable name was sitting in
 * the folder path underneath the whole time. The exact id stays on the line beside it: it is the string somebody
 * types into a terminal, and a view that shows only the friendly name makes it unfindable. */
it(`titles a sandbox by its folder rather than by a blob of hex`, () => {
    const text = mount([busyMachine()]).textContent ?? ``;
    expect(text).toContain(`radarsu-web-platform-bce57bb9fe3b`);
    expect(text).toContain(`radarsu-local-0738cd6b5027`);
    expect(text).toContain(`sandbox-bce57bb9fe3b`);
});

// A folded row costs one line and still says how much is under it. The detail it hides is genuinely hidden,
// which is the whole of the saving.
it(`folds a sandbox to a line that still says what is under it`, () => {
    granted();
    const text = mount([busyMachine()]).textContent ?? ``;
    expect(text).toContain(`2 ports`);
    // The rows that are fine keep their paths and images behind the fold.
    expect(text).not.toContain(`/home/radarsu/intentic/radarsu-web-platform-bce57bb9fe3b`);
    expect(text).not.toContain(`img:a`);
});

/* WHICH ROWS OPEN THEMSELVES: the ones somebody has to act on. Not merely stopped, plenty of sandboxes are
 * stopped on purpose, and unfolding every one of them hands back the wall this is folding away. */
it(`opens the sandbox that wants something and leaves the rest folded`, () => {
    granted();
    const text = mount([busyMachine()]).textContent ?? ``;
    // The contended port's row is open, so its folder and the sentence about the port are both on screen.
    expect(text).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
    expect(text).toContain(`not on localhost`);
    // The stopped one is not: being stopped is not an errand.
    expect(text).not.toContain(`img:c`);
});

// The machine's own line carries the same idea one level up, so a folded computer still says how much is under
// it and whether anything there wants attention.
it(`folds a computer to a line that counts what is under it`, async () => {
    const el = mount([busyMachine()]);
    await openRow(el, `radarsu-rog`);
    const text = el.textContent ?? ``;
    expect(text).toContain(`3 sandboxes`);
    expect(text).toContain(`2 running`);
    expect(text).toContain(`1 needs attention`);
});

/* AN OPEN COMPUTER LIGHTS UP, THE WAY EVERY OTHER LIST IN THE HUB DOES, and that is what this pins: the tab
 * was reported as the one place where opening a row changed nothing but the arrow. Its machine rows were
 * hand-rolled, so they had none of <DisclosureRow>'s wash; they are that component now, and `bg-content/6` is
 * the app's one open tint rather than this file's idea of one.
 *
 * The `aria-controls` half rides along because the hand-rolled row never had it: `aria-expanded` alone tells a
 * screen reader a row is open and never says what opened, which is the half of the disclosure contract a
 * fourteenth spelling loses. Pinned as "the id resolves to an element" rather than as a string, since the id
 * itself is Vue's. */
it(`lights an open computer the way the rest of the hub does, and names the block it opened`, async () => {
    const el = mount([busyMachine()]);
    // The one machine with a report opens itself, so the wash is on screen before anything is pressed.
    const washed = (): Element[] => [...el.querySelectorAll(`[class*="bg-content/6"]`)];
    expect(washed()).toHaveLength(1);
    expect(washed()[0]?.textContent ?? ``).toContain(`radarsu-rog`);

    const toggle = disclosures(el).find((button) => (button.textContent ?? ``).includes(`radarsu-rog`));
    expect(toggle?.getAttribute(`aria-expanded`)).toBe(`true`);
    expect(el.querySelector(`#${toggle?.getAttribute(`aria-controls`) ?? `none`}`)).not.toBeNull();

    // And goes out with it: a wash that outlived the open row would be a selection nobody made.
    await openRow(el, `radarsu-rog`);
    expect(washed()).toHaveLength(0);
});

/* THE FILTER. Twelve rows and no search meant looking for a port number was reading. It narrows MACHINES and
 * unfolds what matched rather than hiding rows inside a machine: a contended port is explained by naming the
 * sandbox that took it, and filtering that sandbox away would cut the link the explanation depends on. */
it(`finds a machine by a port number and opens what matched`, async () => {
    const el = mount([busyMachine(), { ...syncOnly(), key: `other`, label: `other-pc` }]);
    const field = el.querySelector(`input`);
    expect(field).not.toBeNull();
    field!.value = `8788`;
    field!.dispatchEvent(new Event(`input`));
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`radarsu-rog`);
    expect(text).not.toContain(`other-pc`);
    // The row that holds the port is unfolded, so the answer is on screen rather than one more click away.
    expect(text).toContain(`localhost:8788`);
});

// A filter that matched nothing says so where the rows would have been, rather than leaving a group that looks
// like it has lost its contents.
it(`says when a filter matched nothing`, async () => {
    const el = mount([busyMachine(), { ...syncOnly(), key: `other`, label: `other-pc` }]);
    const field = el.querySelector(`input`);
    field!.value = `zzzz`;
    field!.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(el.textContent ?? ``).toContain(`matches`);
});

/* THE SIGNAL THIS ROW WAS MISSING. A machine ran an agent five days behind a fix for the very bug it was hitting,
 * and this row said "desktop sync 0.1.0" throughout: true, and useless without the version it should have been.
 * Both halves are asserted: the fact, inside the door chip it is about, and the one command that resolves it.
 *
 * The version and the release that supersedes it are separate spans in that chip, so they are asserted separately
 * rather than as one string: what matters is that both reach the reader, not the whitespace between them. */
const behind = (): Computer => ({
    key: `laptop`,
    label: `laptop`,
    syncEnrolled: true,
    platform: `linux`,
    report: {
        hostname: `laptop`,
        os: `linux`,
        agents: { sync: `0.1.0` },
        sandboxes: [],
        pairings: [],
        ports: [],
        watcher: { running: true },
        capturedAt: Date.now(),
    },
});

it(`says when a computer's sync agent is behind, and what to run`, () => {
    const text = mount([behind()]).textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`0.1.0`);
    expect(text).toContain(`1.183.0 available`);
    expect(text).toContain(`intentic-machine upgrade`);
});

// A current agent gets neither: a row that nags at a machine with nothing to do is how people learn to read past
// the line entirely.
it(`says nothing about updating a computer that is already current`, () => {
    const row = behind();
    const text = mount([{ ...row, report: { ...row.report!, agents: { sync: `1.183.0` } } }]).textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`1.183.0`);
    expect(text).not.toContain(`available`);
    expect(text).not.toContain(`intentic-machine upgrade`);
});

// And a sandbox that has never reached the registry has no yardstick, so it makes no claim about anyone's agent.
it(`makes no claim when this sandbox doesn't know the latest release`, () => {
    latest.value = undefined;
    const text = mount([behind()]).textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`0.1.0`);
    expect(text).not.toContain(`available`);
    expect(text).not.toContain(`intentic-machine upgrade`);
});

/* THE PAIRING INVITATION IS A CLAIM ABOUT THE READER, and an unread list is not grounds for it. The empty state
 * says "no computer is paired with this sandbox yet" and then tells them how to pair one, so the person it
 * reached first was the person who had already done it, on every cold load, until the list arrived and replaced
 * it with their laptop. An empty `computers` means that only once the read is done. */
it(`does not offer to pair a first computer while the list is still being read`, () => {
    computersLoading.value = true;
    expect(mount([]).textContent ?? ``).not.toContain(`No computer is paired`);
});

// Deferred, not lost: once the read lands empty, the invitation is the right thing to say and is said.
it(`offers to pair a first computer once the read lands empty`, () => {
    computersLoading.value = false;
    expect(mount([]).textContent ?? ``).toContain(`No computer is paired`);
});

/* THE CLOCK MUST NOT REBUILD THE PAGE.
 *
 * Every derivation on this tab hangs off the app's one-second clock: `label` reads it, `sorted` sorts by `label`,
 * `rows` maps `sorted` and groups every machine's folders and ports, and `shown`, `tally`, `blocks` and the
 * auto-open set all read `rows`. So the entire list was rebuilt and re-rendered once a second, for data that
 * arrives every ten, on a page that can be left open all day. Nothing here needs finer time than the poll: both
 * facts read off the clock (a stale report, a stalled watcher) are thresholds a MINUTE wide.
 *
 * Pinned by counting derivations across three ticks INSIDE one quantised instant. A regression here is silent,
 * costs nothing anybody can point at, and is exactly the kind of thing a later edit reintroduces by reaching for
 * the raw clock because it is right there. */
it(`does not re-derive the whole list on every tick of the app clock`, async () => {
    vi.useFakeTimers();
    // A round instant, so three seconds of ticking cannot cross a bucket boundary and legitimately re-derive.
    vi.setSystemTime(1_700_000_000_000);
    mount([managed(true), { ...managed(false), key: `desktop`, label: `desktop` }]);
    await nextTick();

    const derivedOnce = derivations;
    expect(derivedOnce).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(3_000);
    await nextTick();
    expect(derivations).toBe(derivedOnce);
});

/* ---- this sandbox's runners, under the machine that holds them ---- */

/* THE SECOND KIND OF CONTAINER ON SOMEBODY'S COMPUTER. The list above a runner's row is workspaces belonging
 * to a PERSON; a runner belongs to this sandbox, and the row exists so the machine that holds it can be told
 * to make or unmake one. Filtered by host, because the buttons are that machine's: a runner on another
 * computer must not offer a Remove that would be sent to this one. */
it(`lists this sandbox's runners under the computer holding them, with what that machine has to offer`, async () => {
    runnersList.value = [
        { id: `rig`, host: `host-1`, online: true, facts: { cpus: 16, memoryMb: 26_048, load: 0.25 } },
        { id: `elsewhere`, host: `other-host`, online: true },
    ];
    const el = mount([managed(true)]);
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`Runners for this sandbox`);
    expect(text).toContain(`rig`);
    expect(text).toContain(`16 cores`);
    // A runner on a different machine belongs under that machine's row, never this one's.
    expect(text).not.toContain(`elsewhere`);
});

// A runner that is paired but whose machine is asleep keeps its row and says so: it is still this sandbox's
// runner, and the fix is to wake the machine rather than to make another one.
it(`keeps an offline runner's row and names the state rather than hiding it`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: false }];
    const el = mount([managed(true)]);
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Offline`);
});

// A machine with none says what one is FOR, because the button beside it asks for a decision the reader has
// never had to make before.
it(`explains what a runner is on a machine that has none`, async () => {
    const el = mount([managed(true)]);
    await nextTick();
    expect(el.textContent ?? ``).toContain(`None here yet`);
});

/* DRIFT IS SAID ON THE ROW, with the button that ends it. A runner months behind the parent runs turns fine
 * until the day it does not, and then the failure reads as a link error rather than as an old machine. */
it(`marks a runner whose build has drifted from this sandbox, and offers the update`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: true, parity: `outdated` }];
    const el = mount([managed(true)]);
    await nextTick();
    const text = el.textContent ?? ``;
    expect(text).toContain(`outdated`);
    expect(text).toContain(`Update`);
});

// A runner matching the parent says nothing about its build: a badge on every healthy row is noise, and the
// update button on one is a click with nothing behind it.
it(`says nothing about the build of a runner that matches`, async () => {
    runnersList.value = [{ id: `rig`, host: `host-1`, online: true, parity: `current` }];
    const el = mount([managed(true)]);
    await nextTick();
    expect(el.textContent ?? ``).not.toContain(`outdated`);
    expect(el.textContent ?? ``).not.toContain(`Update`);
});

/* ---- port mirroring, the switch on the user's OWN localhost ----
 *
 * The complaint this closes: a sandbox's dev server takes localhost:5173 on somebody's own desk, where their own
 * was going to go, and the only ways to stop it were to unpair the sandbox or revoke the enrollment, each of
 * which takes the file sync and the git bridge with it. "Not on my localhost today" had no expression anywhere.
 *
 * The switch lives on the MACHINE, because the localhost being written to is there, and it must hold while this
 * sandbox is asleep or unreachable. So this button does not set a flag here: it runs that machine's own CLI over
 * the computer connection, which is why the tests below are about what LEAVES rather than about local state. */
// `null` for "no computer door", not `undefined`: an explicit `undefined` argument takes the default, which is
// the opposite of what the sync-only test is asking for.
const mirrored = (state: `on` | `off`, door: { hostId: string; online: boolean } | null = { hostId: `host-1`, online: true }): Computer => ({
    key: `laptop`,
    label: `laptop`,
    syncEnrolled: true,
    platform: `linux`,
    ...door,
    report: {
        hostname: `laptop`,
        os: `linux`,
        agents: { sync: `1.183.0` },
        sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `img:a` }],
        pairings: [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: state }],
        /* THE PORT IS CARRIED IN BOTH STATES ON PURPOSE. Once the switch is off the machine reports none, it
         * tears its forwards down on the same tick it reads the flag, so a report holding both is the one-tick
         * reading in between, and that is precisely the state whose row must not print `localhost:5173` at an
         * address that no longer answers. */
        ports: [{ port: 5173, host: `127.0.0.1`, sandboxId: `work-abc`, state: `mirrored`, command: `node vite` }],
        watcher: { running: true },
        capturedAt: Date.now(),
    },
});

/* THE ROW THAT USED TO DRAW NOTHING. With mirroring off the machine reports no ports, and no ports rendered as
 * no ports line at all: identical to a sandbox serving nothing, which is how "why is localhost empty" became a
 * question with no answer on screen. */
it(`says a computer was told to keep its localhost clear, and offers the way back`, async () => {
    const el = mount([mirrored(`off`)]);
    await openRow(el, `work`);
    const text = el.textContent ?? ``;
    expect(text).toContain(`isn't putting this sandbox's ports on its own localhost`);
    // The switch points the other way, because the machine says it is already off.
    expect(labels(el)).toContain(`Start mirroring`);
    expect(labels(el)).not.toContain(`Stop mirroring`);
    // And the stale address is suppressed rather than printed under the sentence contradicting it.
    expect(text).not.toContain(`localhost:5173`);
});

/* WHAT LEAVES WHEN IT IS PRESSED. Bare, the machine's CLI acts on every sandbox it pairs, which is a reasonable
 * thing to want from a terminal and never what a button on one row should do to a colleague's pairing on the
 * same laptop. So the row's own sandbox id travels with the name. */
it(`takes this sandbox's ports off that computer's localhost, and nobody else's`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`localhost:5173`);
    const button = [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`));
    button?.click();
    await nextTick();
    expect(mirrorCalls).toEqual([{ hostId: `host-1`, command: `mirror-off`, sandboxId: `work-abc` }]);
});

/* THE CLI'S OWN SENTENCE, KEPT. It names the ports it actually took off localhost, which is more than this side
 * knows, and it is the same sentence the reader would have got from the terminal this button replaces. */
it(`shows the machine's own answer under the row that was pressed`, async () => {
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`))?.click();
    await nextTick();
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Port mirroring OFF for: work-abc`);
});

// A refusal is an ANSWER, not a crash: the machine's switches are its own, and it says which one to flip. It
// arrives as the machine explaining itself rather than as this page reporting a failure.
it(`keeps the machine's words when it declines to do it`, async () => {
    mirrorAnswer = { ok: false, message: `Turn on "Run commands" for this computer.` };
    const el = mount([mirrored(`on`)]);
    await openRow(el, `work`);
    [...el.querySelectorAll(`button`)].find((control) => (control.textContent ?? ``).includes(`Stop mirroring`))?.click();
    await nextTick();
    await nextTick();
    expect(el.textContent ?? ``).toContain(`Turn on "Run commands" for this computer.`);
});

/* NO DOOR, NO BUTTON. Desktop sync carries the pairing and its state, so the row can still SAY mirroring is off,
 * but the switch travels over the computer connection and there isn't one: a button that fails when taken is
 * worse than the CLI line it replaced. This is the "only if the sandbox has that computer capability" rule. */
it(`states mirroring without offering the switch on a computer it cannot run commands on`, async () => {
    const el = mount([mirrored(`off`, null)]);
    await openRow(el, `work`);
    expect(el.textContent ?? ``).toContain(`isn't putting this sandbox's ports on its own localhost`);
    expect(labels(el)).not.toContain(`Start mirroring`);
});

/* A SWITCH SOMEBODY THREW IS NOT A FAULT, pinned on the derivation both the folded line and the open-by-default
 * rule read. Mirroring off is a FACT: uncoloured, and it must not unfold the row forever to report the thing it
 * was just asked to do. The contended port alongside it is the one-tick reading again, and it must not warn
 * either, because "not on localhost" is exactly what was asked for. */
it(`counts mirroring off as a fact rather than something to fix`, () => {
    const groups = sandboxGroups(
        [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: `off` }],
        [{ port: 5173, sandboxId: `work-abc`, state: `busy` }],
    );
    expect(groups.map((group) => groupSummary(group))).toEqual([{ facts: [`mirroring off`], warnings: [] }]);
    expect(groups.filter(groupNeedsAttention)).toEqual([]);
});

// And the same port with mirroring ON still warns, which is what stops the guard above from swallowing the
// signal this view was built for: a dev server that never reached localhost because something else holds 5173.
it(`still warns about a port that missed localhost while mirroring is on`, () => {
    const groups = sandboxGroups(
        [{ sandboxId: `work-abc`, mode: `sync`, localDir: `/home/ada/work`, mutagenStatus: `watching`, mirroring: `on` }],
        [{ port: 5173, sandboxId: `work-abc`, state: `busy` }],
    );
    expect(groups.map((group) => groupSummary(group))).toEqual([{ facts: [], warnings: [`1 port not on localhost`] }]);
    expect(groups.filter(groupNeedsAttention)).toHaveLength(1);
});
