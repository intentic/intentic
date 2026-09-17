// @vitest-environment jsdom
//
// THE DEV REBUILD CARD. The build runs on another machine, detached, and ends by replacing the container this page is
// talking to — so what is pinned here is that the card keeps saying something the whole way through: while it builds,
// while the sandbox restarts underneath it, and after a remount that threw the component away mid-build.
import { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK, devRebuildLogPath } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { forgetHubWork, hubWorkKey, hubWorkRunning } from "../../../shell/hub/hubWork";

const hostId = ref<string | undefined>(`host-1`);
// What the card asks the door rule about: its own checkout, since one PC answers for this container through several
// doors and only the checkout's path picks between them.
const askedAbout: (string | undefined)[] = [];
const runDeviceCommand = vi.hoisted(() => vi.fn());
vi.mock(`../devices/useDevices`, () => ({
    useHostHolding: (_slug: () => string | undefined, path: () => string | undefined) => {
        askedAbout.push(path());
        return hostId;
    },
    useDevices: () => ({ devices: ref([]) }),
    runDeviceCommand,
}));
vi.mock(`../client/sandboxClient`, () => ({ SandboxHttpError: class extends Error {} }));
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: ref(`sbx-1`) }) }));
// What the restart will interrupt, and whether it hands it back: both are read at the moment of asking, so both are
// driven from here. `turnInFlight` stays real — what counts as mid-turn is not this card's opinion.
const fleet = ref<{ status: string }[]>([]);
vi.mock(`../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet }) }));
const settings = ref<{ autoResumeOnRestart: boolean } | undefined>(undefined);
vi.mock(`../overview/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings }) }));

const { default: DevRebuild } = await import("./DevRebuild.vue");
// The same module instance the card uses, so a test can put a run in flight without driving the confirm dialog first.
const { useDevRebuild } = await import("./useDevRebuild");

let app: App | undefined;

const mount = (props: { slug: string; base: string; root?: string }): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DevRebuild, props) });
    // The confirm dialog is PrimeVue's, and reads its config through inject; without the plugin it renders into a throw.
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(el);
    return el;
};

// A distinct sandbox per test: the run deliberately lives at module scope, longer than any component.
let counter = 0;
const nextSlug = (): string => `demo-${(counter += 1)}`;

const buttonSaying = (words: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(words));

// What the daemon hands back for `dev-rebuild-log`: the command's stdout, header line first.
const log = (quiet: string, ...lines: readonly string[]): { ok: true; message: string } => ({
    ok: true,
    message: [`${DEV_REBUILD_QUIET_MARK} ${quiet}`, ...lines].join(`\n`),
});
const started = { ok: true, message: `The rebuild is running on that device.` };

const POLL_MS = 4_000;
const settleUi = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await nextTick();
};

beforeEach(() => {
    vi.useFakeTimers();
    askedAbout.length = 0;
    runDeviceCommand.mockReset();
    // Nothing has rebuilt anything yet: the card's own probe on mount finds no log.
    runDeviceCommand.mockResolvedValue(log(`-`));
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockReturnValue({
        top: 100,
        left: 100,
        width: 120,
        height: 36,
        right: 220,
        bottom: 136,
        x: 100,
        y: 100,
        toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
    fleet.value = [];
    settings.value = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    // A run this test left in flight is module state like the run itself, and would be counted by the next test's
    // row.
    forgetHubWork();
    hostId.value = `host-1`;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.restoreAllMocks();
});

it(`renders button and reveals command overlay with cost on focus`, async () => {
    const root = `/home/radarsu/intentic/workspace-82789f4106b4/intentic`;
    const el = mount({ slug: nextSlug(), base: `intentic-sandbox:dev`, root });
    const button = el.querySelector(`button`);

    // The device it fires at is the one that holds this checkout: the Windows door onto the same PC reports the same
    // container and answers a `sh` line with a parse error.
    expect(askedAbout).toContain(root);
    expect(button).not.toBeNull();
    expect(el.textContent).not.toContain(`Runs intentic-sandbox:dev from your checkout`);

    const trigger = el.querySelector(`div.inline-flex`);
    expect(trigger).not.toBeNull();

    trigger?.dispatchEvent(new FocusEvent(`focusin`));
    await nextTick();

    const overlay = document.querySelector(`.ui-anchored-right`);
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain(`Runs intentic-sandbox:dev from your checkout, not a published release.`);
    expect(overlay?.textContent).toContain(`pnpm rebuild:sandbox`);
    expect(overlay?.textContent).toContain(root);
    expect(overlay?.textContent).toContain(`Builds the image while you keep working`);
});

it(`renders current state text in fallback when device or root is absent`, () => {
    hostId.value = undefined;
    const el = mount({ slug: nextSlug(), base: `intentic-sandbox:dev`, root: `/home/radarsu/intentic` });
    expect(el.textContent).toContain(`Runs intentic-sandbox:dev from your checkout, not a published release.`);
});

it(`confirms first, then starts the build and stops offering to start another`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#1 [internal] load build definition`));

    buttonSaying(`Rebuild from checkout`)?.click();
    await nextTick();
    expect(document.body.textContent).toContain(`Rebuild from checkout?`);
    // The two costs are told apart rather than run through one sentence: the minutes that interrupt nothing, and the
    // half-minute that does.
    expect(document.body.textContent).toContain(`Builds the image`);
    expect(document.body.textContent).toContain(`Restarts the sandbox`);
    expect(document.body.textContent).toContain(`~30s`);
    // The checkout is named in full, split for reading, not summarised away.
    expect(document.body.textContent).toContain(`/home/ada/`);
    expect(document.body.textContent).toContain(`intentic`);
    // The header icon means this dialog draws its own title bar, which drops the one `aria-labelledby` points at: a
    // dangling reference leaves the box announced with no name at all.
    const named = document.querySelector(`[role="dialog"]`)?.getAttribute(`aria-labelledby`) ?? ``;
    expect(document.getElementById(named)?.textContent).toBe(`Rebuild from checkout?`);

    buttonSaying(`Rebuild now`)?.click();
    await settleUi();

    expect(runDeviceCommand).toHaveBeenCalledWith(`host-1`, `dev-rebuild`);
    expect(el.textContent).toContain(`Rebuilding…`);
    expect(buttonSaying(`Rebuilding…`)?.disabled).toBe(true);
});

// THE COST NOBODY CAN SEE FROM HERE. The build interrupts nothing, so the only moment this is worth saying is the
// one where it can still be avoided for free: before it starts, when waiting for the fleet to settle costs nothing.
it(`counts the turns the restart will interrupt before it is agreed to`, async () => {
    fleet.value = [{ status: `running` }, { status: `idle` }, { status: `starting` }];
    mount({ slug: nextSlug(), base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });

    buttonSaying(`Rebuild from checkout`)?.click();
    await nextTick();

    expect(document.body.textContent).toContain(`2 agents are mid-turn`);
    expect(document.body.textContent).toContain(`would need sending again`);
});

it(`says the turns come back when this sandbox resumes them after a restart`, async () => {
    fleet.value = [{ status: `running` }];
    settings.value = { autoResumeOnRestart: true };
    mount({ slug: nextSlug(), base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });

    buttonSaying(`Rebuild from checkout`)?.click();
    await nextTick();

    expect(document.body.textContent).toContain(`An agent is mid-turn`);
    expect(document.body.textContent).toContain(`picked up once the sandbox is back`);
});

it(`says nothing about interrupted work when there is none to interrupt`, async () => {
    mount({ slug: nextSlug(), base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });

    buttonSaying(`Rebuild from checkout`)?.click();
    await nextTick();

    expect(document.body.textContent).toContain(`Rebuild from checkout?`);
    expect(document.body.textContent).not.toContain(`mid-turn`);
});

// The complaint this card is answering: a message, and nothing else, for minutes.
it(`shows the machine's own output, a running clock and what is happening to the sandbox`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#12 [builder 4/9] RUN pnpm install`));

    await useDevRebuild(slug).start(`host-1`);
    await settleUi();

    expect(el.textContent).toContain(`Building the image from your checkout`);
    expect(el.textContent).toContain(`#12 [builder 4/9] RUN pnpm install`);
    // One spinner for one run: the line above the pane says a build is going, and the pane no longer repeats it
    // underneath. That the build outlives this page is said by the hub row instead, where leaving can be seen.
    expect(el.textContent).not.toContain(`it keeps going even if you leave this page`);
    expect(hubWorkRunning(hubWorkKey(`sandbox`, `environment`))).toBe(`Rebuilding from your checkout`);

    await settleUi(POLL_MS * 16);
    expect(el.textContent).toMatch(/1m \d\ds/);
});

// A build inside a slow docker layer prints nothing for minutes. A still pane is not a stuck build, and after a while
// the card has to be the one to say which it is.
it(`explains a log that has gone quiet instead of leaving it to be read as stuck`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`240`, `#9 [builder 5/9] RUN cargo build --release`));

    await useDevRebuild(slug).start(`host-1`);
    await settleUi();

    expect(el.textContent).toContain(`Nothing new in the log for 4m`);
});

// The build's last act replaces this container, so the daemon answering these reads dies mid-build. That is the swap.
it(`says the sandbox is restarting when the daemon goes quiet mid-build`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#18 exporting to image`));
    await useDevRebuild(slug).start(`host-1`);
    await settleUi();

    runDeviceCommand.mockRejectedValue(new TypeError(`Failed to fetch`));
    await settleUi(POLL_MS);

    expect(el.textContent).toContain(`Restarting your sandbox on the new image`);
    // What it printed before the connection went is still on screen: the restart is not a reason to forget it.
    expect(el.textContent).toContain(`#18 exporting to image`);
});

it(`reports a finished rebuild with how long it took`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#20 naming to intentic-sandbox:dev`));
    await useDevRebuild(slug).start(`host-1`);
    await settleUi(POLL_MS * 30);

    runDeviceCommand.mockResolvedValue(log(`0`, `#20 naming to intentic-sandbox:dev`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await settleUi(POLL_MS);

    expect(el.textContent).toMatch(/Rebuilt from your checkout in 2m \d\ds/);
    expect(el.textContent).toContain(`You're running the new image.`);
    expect(buttonSaying(`Rebuild from checkout`)).toBeInstanceOf(HTMLButtonElement);
    // And the hub row stops turning with it: a mark left over a finished build is worse than none.
    expect(hubWorkRunning(hubWorkKey(`sandbox`, `environment`))).toBeUndefined();
});

// A full rebuild on the machine this repo is developed on has taken two hours. A card that gave up at 45 minutes
// called a healthy build lost, with its log still growing on screen.
it(`keeps following a build that runs for hours while its log keeps growing`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`3`, `#10 [builder 6/9] RUN cargo install cargo-xwin`));
    await useDevRebuild(slug).start(`host-1`);

    await settleUi(95 * 60_000);

    expect(el.textContent).toContain(`Building the image from your checkout`);
    expect(el.textContent).not.toContain(`stopped reporting`);
    expect(el.textContent).toMatch(/95m \d\ds/);
});

it(`gives a failed rebuild its exit status and points at the whole log`, async () => {
    const slug = nextSlug();
    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand
        .mockResolvedValueOnce(started)
        .mockResolvedValue(log(`0`, `ERROR: failed to solve: process did not complete`, `${DEV_REBUILD_EXIT_MARK} 1`));

    await useDevRebuild(slug).start(`host-1`);
    await settleUi();

    expect(el.textContent).toContain(`The rebuild failed on that device (exit 1).`);
    expect(el.textContent).toContain(`ERROR: failed to solve: process did not complete`);
    expect(el.textContent).toContain(devRebuildLogPath(slug));
});

// Switching views unmounts this card. The build carries on; so must what the reader is told about it.
it(`picks a running build back up after the card has been thrown away and redrawn`, async () => {
    const slug = nextSlug();
    const first = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`3`, `#7 [builder 3/9] COPY . .`));
    await useDevRebuild(slug).start(`host-1`);
    await settleUi();
    expect(first.textContent).toContain(`#7 [builder 3/9] COPY . .`);

    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;

    const second = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    await settleUi();
    expect(second.textContent).toContain(`Building the image from your checkout`);
    expect(second.textContent).toContain(`#7 [builder 3/9] COPY . .`);
    // One build, not two: remounting the card must never fire a second rebuild.
    expect(runDeviceCommand.mock.calls.filter(([, command]) => command === `dev-rebuild`)).toHaveLength(1);
});

// Reloading, and the restart itself, wipe the page's memory; the marker plus the machine's log are what bring the
// answer back.
it(`reports how a rebuild ended to a page that was reloaded while it ran`, async () => {
    const slug = nextSlug();
    localStorage.setItem(`intentic.devRebuild.${slug}`, String(Date.now() - 420_000));
    runDeviceCommand.mockResolvedValue(log(`2`, `#20 naming to intentic-sandbox:dev`, `${DEV_REBUILD_EXIT_MARK} 0`));

    const el = mount({ slug, base: `intentic-sandbox:dev`, root: `/home/ada/intentic` });
    await settleUi();

    expect(el.textContent).toContain(`Rebuilt from your checkout in 7m`);
});
