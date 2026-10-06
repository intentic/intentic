import "@intentic/testing/dom";
import { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync, freshImport } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";

// A rebuild runs on another machine, detached, and ends by replacing the container this page is talking to. What is
// pinned here is that the run survives all of that: the component being thrown away, the daemon going quiet mid-build,
// and a reload afterwards — because none of those are the build stopping. A refusal is the real SandboxHttpError: an
// answer FROM the daemon, carrying the status the composable branches on.

const runDeviceCommand = jest.fn();
jest.mock(`../../devices/useDevices`, () => ({ runDeviceCommand }));

const { OUT_OF_CONTACT_MS, outOfContact, rebuildRunning, useDevRebuild } = await import("./useDevRebuild");
// The same module evaluated a second time: the page after a reload, its memory gone and this browser's storage intact.
// Imported here rather than inside the test that reloads, so the load is not charged to that test's clock.
const reloaded = await freshImport<typeof import("./useDevRebuild")>(`./useDevRebuild`, import.meta.url);

const HOST = `laptop`;
// The daemon hands back the command's stdout as `message`; `output` is the raw fenced answer, which must never be read
// as log text.
const log = (quiet: string, ...lines: readonly string[]): { ok: true; refused: false; message: string; output: string } => {
    const stdout = [`${DEV_REBUILD_QUIET_MARK} ${quiet}`, ...lines].join(`\n`);
    return { ok: true, refused: false, message: stdout, output: `Exit code 0 (success).\n--- stdout ---\n${stdout}` };
};
const started = { ok: true, refused: false, message: `The rebuild is running on that device.` };
// What a read rides when the daemon carrying it is the container being swapped: no answer at all.
const severed = new TypeError(`Failed to fetch`);
// A read the machine took and then killed at its deadline: `refused` false, because it is this attempt running out of
// time rather than the device turning the command away. The machine's own sentence, verbatim.
const killed = {
    ok: false,
    refused: false,
    message: `The command was killed after 60s. It either takes longer than that, or it is waiting for input that nobody can type: there is no terminal on this end.`,
};

// Each test takes a slug of its own: the run is module state on purpose, so it outlives everything a test could unmount.
let counter = 0;
const nextSlug = (): string => `box-${(counter += 1)}`;

// One poll interval, with every promise it settles.
const POLL_MS = 4_000;
const nextPoll = async (times = 1): Promise<void> => {
    for (let index = 0; index < times; index += 1) {
        await advanceTimersByTimeAsync(POLL_MS);
    }
};

beforeEach(() => {
    jest.useFakeTimers();
    runDeviceCommand.mockReset();
    localStorage.clear();
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

it(`follows the machine's log from the moment the build is under way`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`3`, `#8 [builder 2/9] RUN pnpm install`));
    const { run } = useDevRebuild(slug);

    await useDevRebuild(slug).start(HOST);
    expect(run.phase).toBe(`building`);
    expect(runDeviceCommand).toHaveBeenNthCalledWith(1, HOST, `dev-rebuild`);

    await nextPoll(0);
    await advanceTimersByTimeAsync(0);
    expect(runDeviceCommand).toHaveBeenNthCalledWith(2, HOST, `dev-rebuild-log`);
    expect(run.lines).toEqual([`#8 [builder 2/9] RUN pnpm install`]);
    expect(run.quietFor).toBe(3);
});

it(`counts the wait in seconds while the build runs, and stops the clock when it ends`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `working`));
    const { run, elapsed } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);

    await nextPoll(15);
    // One tick past the last poll window: a timer due exactly at a window's edge is left for the next advance.
    await advanceTimersByTimeAsync(1_000);
    expect(elapsed.value).toBeGreaterThanOrEqual(60);

    runDeviceCommand.mockResolvedValue(log(`0`, `done`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await nextPoll(1);
    expect(run.phase).toBe(`done`);
    const settled = elapsed.value;
    await advanceTimersByTimeAsync(30_000);
    expect(elapsed.value).toBe(settled);
});

// The build's last act is swapping this container, so the daemon carrying these polls dies underneath them. That is the
// swap, not a failure, and the run has to say so rather than going blank.
it(`reads the daemon going quiet mid-build as the restart, then picks the log back up`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#14 exporting layers`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockRejectedValue(new TypeError(`Failed to fetch`));
    await nextPoll(1);
    expect(run.phase).toBe(`restarting`);
    // The lines the build did print are kept: a restart is not a reason to forget what it said.
    expect(run.lines).toEqual([`#14 exporting layers`]);

    runDeviceCommand.mockResolvedValue(log(`1`, `#14 exporting layers`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await nextPoll(1);
    expect(run.phase).toBe(`done`);
    expect(run.exitCode).toBe(0);
});

// An answer FROM the daemon saying the device is away is not the swap: the container is plainly still here.
it(`does not call an answered error a restart`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `building`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    // 409: the daemon is right here and says the device is away. The device comes back; keep asking.
    runDeviceCommand.mockRejectedValue(new SandboxHttpError(409, `"laptop" could not be reached.`));
    await nextPoll(1);
    expect(run.phase).toBe(`building`);
    expect(run.trouble).toBe(`"laptop" could not be reached.`);
});

// A page newer than the container serving it — a dogfooding state — asking for a command this daemon's contract has
// never heard of. Four seconds later it will still not have heard of it.
it(`stops asking a daemon that does not know the command`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `building`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockRejectedValue(new SandboxHttpError(400, `This sandbox's daemon doesn't know that route.`));
    await nextPoll(1);
    expect(run.phase).toBe(`lost`);
    expect(run.trouble).toContain(`doesn't know that route`);

    const asked = runDeviceCommand.mock.calls.length;
    await nextPoll(3);
    expect(runDeviceCommand).toHaveBeenCalledTimes(asked);
});

it(`ends on the build's own exit status, and says which it was`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`0`, `ERROR: failed to solve`, `${DEV_REBUILD_EXIT_MARK} 1`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    expect(run.phase).toBe(`failed`);
    expect(run.exitCode).toBe(1);
    expect(rebuildRunning(run.phase)).toBe(false);
});

// The machine's own refusal — its "Run commands" switch off, no checkout recorded — is a value, not a wait.
it(`stops on the device's refusal and keeps its words`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValue({ ok: false, refused: true, message: `Refused: "Run commands" is switched off for this device.` });
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);

    expect(run.phase).toBe(`failed`);
    expect(run.trouble).toContain(`Run commands`);
    expect(runDeviceCommand).toHaveBeenCalledTimes(1);
});

// A MACHINE IS BUSIEST WHILE IT IS BUILDING, so the read that follows a build is the read most likely to be killed at
// its deadline — and the build it is reading about is detached out there, entirely unaffected by a poll that lost.
it(`treats a read the machine killed as a hiccup, not as a rebuild that failed`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#8 [builder 2/9] RUN pnpm install`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockResolvedValue(killed);
    await nextPoll(1);
    expect(run.phase).toBe(`building`);
    expect(run.trouble).toContain(`killed after 60s`);
    // The lines the last good read brought are kept: a read that failed said nothing to replace them with.
    expect(run.lines).toEqual([`#8 [builder 2/9] RUN pnpm install`]);

    // And the follow is still going, so the build's own ending still arrives.
    runDeviceCommand.mockResolvedValue(log(`1`, `#14 exporting layers`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await nextPoll(1);
    expect(run.phase).toBe(`done`);
    expect(run.exitCode).toBe(0);
    expect(run.trouble).toBeUndefined();
});

// Reads that never land leave `quietFor` frozen at whatever the last good one said, so the log's own silence can never
// end this follow. Going unheard-from is what does, on the same fifteen minutes a quiet log gets.
it(`gives up once the machine has gone unheard-from for as long as a quiet log would`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(killed);
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);

    await nextPoll(60);
    expect(run.phase).toBe(`building`);

    await nextPoll(180);
    expect(run.phase).toBe(`lost`);
    expect(run.trouble).toContain(`killed after 60s`);
    // Ended by silence, but long before the restart step: a machine too busy to answer, not a swap that never came back.
    expect(run.unheard).toBe(true);
    expect(outOfContact(run, Date.now())).toBe(false);
});

// Its "Run commands" switch went off mid-build, or the checkout moved out of that door's reach. The build is still out
// there; what ended is this browser's only window on it, which is what `lost` says and `failed` does not.
it(`calls a device that refuses the read lost, not a rebuild that failed`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#3 [base 1/4]`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockResolvedValue({ ok: false, refused: true, message: `Refused: "Run commands" is switched off for this device.` });
    await nextPoll(1);
    expect(run.phase).toBe(`lost`);
    expect(run.trouble).toContain(`Run commands`);
    expect(run.exitCode).toBeUndefined();
});

// Switching views unmounts the card. The build does not care, and neither does the run.
it(`hands the same live run to a second reader of the same sandbox`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`5`, `#3 [base 1/4]`));
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    // A fresh call is what a remounted component does; it must not start a second build or forget the first.
    const { run, elapsed } = useDevRebuild(slug);
    expect(run.phase).toBe(`building`);
    expect(run.lines).toEqual([`#3 [base 1/4]`]);
    expect(elapsed.value).toBeGreaterThan(0);
    expect(runDeviceCommand).not.toHaveBeenCalledWith(HOST, `dev-rebuild`, expect.anything());
});

// After the swap the page comes back on the new image with its memory wiped; the marker is what says a rebuild was
// being waited on, and the machine's log says how it went.
it(`resumes from the marker a reload left behind, and reports the outcome`, async () => {
    const slug = nextSlug();
    localStorage.setItem(`intentic.devRebuild.${slug}`, String(Date.now() - 300_000));
    runDeviceCommand.mockResolvedValue(log(`4`, `#18 naming to intentic-sandbox:dev`, `${DEV_REBUILD_EXIT_MARK} 0`));

    const { run, elapsed } = useDevRebuild(slug);
    useDevRebuild(slug).adopt(HOST);
    await advanceTimersByTimeAsync(0);

    expect(run.phase).toBe(`done`);
    // Dated from the marker, so the reader is told how long the whole rebuild took, not how long since the reload.
    expect(elapsed.value).toBeGreaterThanOrEqual(300);
    expect(localStorage.getItem(`intentic.devRebuild.${slug}`)).toBeNull();
});

// A rebuild run from a terminal is the same rebuild; a log from last week is not news.
it(`adopts a rebuild nobody here started only while its log is still growing`, async () => {
    const fresh = nextSlug();
    runDeviceCommand.mockResolvedValue(log(`6`, `#5 [builder 1/9]`));
    const live = useDevRebuild(fresh);
    live.adopt(HOST);
    await advanceTimersByTimeAsync(0);
    expect(live.run.phase).toBe(`building`);

    const stale = nextSlug();
    runDeviceCommand.mockResolvedValue(log(`90000`, `an old build`));
    const quiet = useDevRebuild(stale);
    quiet.adopt(HOST);
    await advanceTimersByTimeAsync(0);
    expect(quiet.run.phase).toBe(`idle`);
    expect(quiet.run.lines).toEqual([]);
});

it(`says nothing about a machine with no rebuild log at all`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValue(log(`-`));
    const { run } = useDevRebuild(slug);
    useDevRebuild(slug).adopt(HOST);
    await advanceTimersByTimeAsync(0);
    expect(run.phase).toBe(`idle`);
});

// A machine that sleeps mid-build never writes the exit mark, so the log simply stops. Waiting forever on it would be
// the same nothing the card showed before.
it(`gives up on a log that stopped growing and never said how it ended`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`16000`, `#9 [builder 5/9] RUN cargo build`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    expect(run.phase).toBe(`lost`);
    expect(run.lines).toEqual([`#9 [builder 5/9] RUN cargo build`]);
});

it(`keeps a settled run until it is dismissed, and refuses to dismiss a live one`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `still going`));
    const follower = useDevRebuild(slug);
    await follower.start(HOST);
    await nextPoll(1);

    follower.dismiss();
    expect(follower.run.phase).toBe(`building`);

    runDeviceCommand.mockResolvedValue(log(`0`, `built`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await nextPoll(1);
    follower.dismiss();
    expect(follower.run.phase).toBe(`idle`);
    expect(follower.run.lines).toEqual([]);
});

// THE RESTART STEP GONE SILENT. The swap takes down the daemon every read rides, so a silence there is the sandbox's own,
// and a healthy one is back inside half a minute. Past the patience the lane and the gate give a restart, the card stops
// promising a reconnect: on 2026-10-06 it kept promising for eighteen minutes over a daemon that crash-looped.
it(`calls the restart step out of contact at two minutes unheard, and not a millisecond before`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#18 exporting to image`));
    const { run } = useDevRebuild(slug);
    const begun = Date.now();
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockRejectedValue(severed);
    await nextPoll(1);
    expect(run.phase).toBe(`restarting`);
    expect(run.stage).toBe(`swap`);
    // The last read that landed is the one a poll before the daemon went.
    expect(run.heardAt).toBe(begun + POLL_MS);

    expect(OUT_OF_CONTACT_MS).toBe(120_000);
    expect(outOfContact(run, begun + POLL_MS + OUT_OF_CONTACT_MS - 1)).toBe(false);
    expect(outOfContact(run, begun + POLL_MS + OUT_OF_CONTACT_MS)).toBe(true);
});

// Before the swap a silence is a machine busy with the very build being read about, which says nothing about the build.
it(`never calls a build out of contact before its restart step, however long the machine has gone unheard`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#12 [builder 4/9] RUN pnpm install`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockResolvedValue(killed);
    await nextPoll(150);
    expect(run.phase).toBe(`building`);
    expect(run.stage).toBe(`image`);
    expect(outOfContact(run, Date.now())).toBe(false);
});

// Out of contact ends the promise, not the follow: a slow first boot is still a boot, and the first read that lands is
// the card's way back.
it(`keeps asking once the restart is out of contact, and is back on the first read that lands`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#18 exporting to image`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockRejectedValue(severed);
    await nextPoll(40);
    expect(outOfContact(run, Date.now())).toBe(true);
    const asked = runDeviceCommand.mock.calls.length;
    await nextPoll(3);
    expect(runDeviceCommand).toHaveBeenCalledTimes(asked + 3);

    runDeviceCommand.mockResolvedValue(log(`3`, `#18 exporting to image`, `intentic: waiting for the new sandbox to answer`));
    await nextPoll(1);
    expect(run.phase).toBe(`building`);
    expect(run.heardAt).toBe(Date.now());
    expect(outOfContact(run, Date.now())).toBe(false);

    runDeviceCommand.mockResolvedValue(log(`1`, `intentic: the new sandbox is up`, `${DEV_REBUILD_EXIT_MARK} 0`));
    await nextPoll(1);
    expect(run.phase).toBe(`done`);
    expect(outOfContact(run, Date.now())).toBe(false);
});

// The silence ceiling still ends it, and the run it leaves remembers that it was the restart that went unheard.
it(`settles a restart that never answers as lost, and as out of contact`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `#18 exporting to image`));
    const { run } = useDevRebuild(slug);
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);

    runDeviceCommand.mockRejectedValue(severed);
    await nextPoll(225);
    expect(run.phase).toBe(`restarting`);
    await nextPoll(2);
    expect(run.phase).toBe(`lost`);
    expect(run.unheard).toBe(true);
    expect(outOfContact(run, Date.now())).toBe(true);
    expect(localStorage.getItem(`intentic.devRebuild.${slug}`)).toBeNull();
});

// A RELOAD IS NOT A NEW SILENCE. The tab that reloads mid-swap is the one most likely to, and before this it painted a
// fresh "Restarting onto it" and granted the swap another fifteen minutes each time.
it(`resumes a reload in the restart step on the silence it already had, not a fresh one`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`1`, `intentic: starting the new container`));
    const before = useDevRebuild(slug);
    await before.start(HOST);
    await nextPoll(1);
    runDeviceCommand.mockRejectedValue(severed);
    // Five minutes into a swap that never came back.
    await nextPoll(75);
    const { heardAt, stageAt } = before.run;

    const after = reloaded.useDevRebuild(slug);
    expect(after.run.phase).toBe(`idle`);
    after.adopt(HOST);
    expect(after.run.stage).toBe(`swap`);
    expect(after.run.heardAt).toBe(heardAt);
    expect(after.run.stageAt).toEqual(stageAt);
    // Out of contact from the first paint, before any read has had the chance to fail again.
    expect(reloaded.outOfContact(after.run, Date.now())).toBe(true);

    // And the ceiling counts from that same silence: a poll or two past ten minutes on, where a fresh one would have
    // had fifteen.
    await nextPoll(148);
    expect(after.run.phase).toBe(`restarting`);
    await nextPoll(4);
    expect(after.run.phase).toBe(`lost`);
    expect(reloaded.outOfContact(after.run, Date.now())).toBe(true);
});

// Before the restart step a tab closed mid-build says nothing about the build, so a reload there dates contact from the
// moment it starts asking again — as it always has.
it(`dates contact afresh for a reload that comes before the restart step`, async () => {
    const slug = nextSlug();
    runDeviceCommand.mockResolvedValueOnce(started).mockResolvedValue(log(`2`, `#12 [builder 4/9] RUN pnpm install`));
    await useDevRebuild(slug).start(HOST);
    await nextPoll(1);
    runDeviceCommand.mockResolvedValue(killed);
    await nextPoll(75);

    const after = reloaded.useDevRebuild(slug);
    after.adopt(HOST);
    expect(after.run.stage).toBe(`compile`);
    expect(after.run.heardAt).toBe(Date.now());
    expect(reloaded.outOfContact(after.run, Date.now())).toBe(false);
});
