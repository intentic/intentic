// @vitest-environment jsdom
//
// jsdom because the subject is WHAT A ROW SAYS. The tab drew a name, a reach and a badge, so a Windows laptop and
// a Linux desktop with no sync agent on either rendered as two identical lines — and the pair of rows in the
// report that prompted this were the same machine twice over. What is worth pinning is therefore not the
// derivation (computerFacts.test.ts has that) but that the row actually PUTS it on screen, next to the name, for a
// computer that has nothing else to show.
import type { Computer } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the daemon client) and a media
// query (the UI barrel's useDevice). jsdom plus these two is the whole of it — see daemonRestart.test.ts, which
// cuts the same edge.
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

const computers = ref<Computer[]>([]);
// The FIRST read, not the ten-second poll. Every test below is about a list that has already arrived, so this
// stays false for them; the pair at the bottom drives it to pin what the tab may say before it has.
const computersLoading = ref(false);
vi.mock(`../../composables/sandbox/useComputers`, async () => {
    // reportStale is a plain function of the row and the clock — real, so a row's staleness line is decided the
    // way it is in the app rather than by this file's idea of it.
    const real = await import(`../../composables/sandbox/useComputers`);
    return {
        ...real,
        useComputers: () => ({ computers, error: ref(undefined), isLoading: computersLoading, refetch: () => {} }),
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
vi.mock(`vue-router`, () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: () => {} }) }));

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

afterEach(() => {
    latest.value = `1.183.0`;
    computersLoading.value = false;
    capabilities.value = [];
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* The row from the report: a connected computer, reachable, with no sync agent on it — so no report, and before
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
    // The door it is reachable through, and the version of the agent answering on it — one chip, two spans.
    expect(text).toContain(`connected computer`);
    expect(text).toContain(`0.5.1`);
    // The gap it had before is still said, because the OS does not answer it: this machine still has no agent.
    expect(text).toContain(`no sync agent`);
});

// A machine that never described itself still has to answer "Windows or Linux?" — the card it was added with says
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

// The image is what Update changes, and one sandbox on a machine running something older than its neighbour was
// invisible on a list that named only the container.
it(`names the image each sandbox on the machine is running`, () => {
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
    expect(el.textContent ?? ``).toContain(`ghcr.io/intentic/sandbox:2.3.1`);
});

/* THE VERB ROW, WHICH IS NOW ONE ROW FOR TWO APPS. This tab and the desktop app's manager window drive the same
 * containers on the same machine and had grown different sets of buttons — this one had Restart and no log tail,
 * that one a log tail and no Restart, and neither offered the rollback both of their backends could already do.
 * The buttons come from the kit now (<SandboxVerbs>), so what is asserted here is what a reader of EITHER app
 * gets: pinned from this side because it is the side with a test runner, and it is the same component.
 *
 * A manageable row is a machine this sandbox can reach right now (`hostId`, `online`) whose group has a
 * container — the three conditions `manageable` names. */
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

const labels = (el: HTMLElement): string[] => [...el.querySelectorAll(`button`)].map((button) => button.textContent?.trim() ?? ``);

// Every switch granted — the state a row reaches once its computer is connected AND permitted, which is what the
// verb tests below are about. Without it the row correctly says which grant is missing instead.
const granted = (): void => {
    capabilities.value = [{ id: `host-1`, config: { platform: `linux`, shell: `on`, sandboxes: `on`, sandboxRemove: `on` } }];
};

it(`offers the same verbs a running sandbox has in the desktop app`, () => {
    granted();
    expect(labels(mount([managed(true)]))).toEqual(expect.arrayContaining([`Restart`, `Stop`, `Update`, `Roll back`, `Logs`, `Remove`]));
});

// Start replaces Restart and Stop rather than joining them: a stopped sandbox has nothing to restart, and Update
// is still offered — a stopped one is exactly what somebody wants on a newer image before starting it again.
it(`offers Start, and no Stop, on a sandbox that is not running`, () => {
    granted();
    const found = labels(mount([managed(false)]));
    expect(found).toEqual(expect.arrayContaining([`Start`, `Update`, `Roll back`, `Logs`, `Remove`]));
    expect(found).not.toContain(`Stop`);
    expect(found).not.toContain(`Restart`);
});

// A fully connected and permitted machine says nothing at all about connecting or permissions — the whole point
// of the three lines below is that they are absent once there is nothing in the way.
it(`says nothing about connecting a computer that is already managing its sandboxes`, () => {
    granted();
    const text = mount([managed(true)]).textContent ?? ``;
    expect(text).not.toContain(`Connect it as a computer`);
    expect(text).not.toContain(`Manage sandboxes on this computer`);
    expect(text).not.toContain(`Remove sandboxes from this computer`);
});

/* THE ROW THE PARITY COMPLAINT WAS ABOUT. A machine paired by the desktop app is enrolled for desktop sync
 * alone, and that door never reports containers — so this tab drew folders and ports and an empty sandbox list
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
        // Empty because the sync agent never fills it — the fact this whole message exists to explain.
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
    // No verbs, because there is no container to aim one at — the state being explained, not worked around.
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
 * on a row where every one of them would be turned down by the machine — a no the page could see coming and
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

/* THE SIGNAL THIS ROW WAS MISSING. A machine ran an agent five days behind a fix for the very bug it was hitting,
 * and this row said "desktop sync 0.1.0" throughout — true, and useless without the version it should have been.
 * Both halves are asserted: the fact, inside the door chip it is about, and the one command that resolves it.
 *
 * The version and the release that supersedes it are separate spans in that chip, so they are asserted separately
 * rather than as one string — what matters is that both reach the reader, not the whitespace between them. */
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
    expect(text).toContain(`intentic-sync upgrade`);
});

// A current agent gets neither — a row that nags at a machine with nothing to do is how people learn to read past
// the line entirely.
it(`says nothing about updating a computer that is already current`, () => {
    const row = behind();
    const text = mount([{ ...row, report: { ...row.report!, agents: { sync: `1.183.0` } } }]).textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`1.183.0`);
    expect(text).not.toContain(`available`);
    expect(text).not.toContain(`intentic-sync upgrade`);
});

// And a sandbox that has never reached the registry has no yardstick, so it makes no claim about anyone's agent.
it(`makes no claim when this sandbox doesn't know the latest release`, () => {
    latest.value = undefined;
    const text = mount([behind()]).textContent ?? ``;
    expect(text).toContain(`desktop sync`);
    expect(text).toContain(`0.1.0`);
    expect(text).not.toContain(`available`);
    expect(text).not.toContain(`intentic-sync upgrade`);
});

/* THE PAIRING INVITATION IS A CLAIM ABOUT THE READER, and an unread list is not grounds for it. The empty state
 * says "no computer is paired with this sandbox yet" and then tells them how to pair one — so the person it
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
