import { fakeKeeper, fixRun, linkView } from "../../testing.js";
import type { IcRun } from "../tools/sandboxes.js";
import {
    backoffMs,
    fixAnswers,
    fixProgress,
    hostedSlugs,
    keeperFixArgs,
    type KeeperState,
    newKeeperState,
    readFixRun,
    runKeeperRound,
    UNREACHABLE_AFTER_MS,
    verdictLine,
} from "./keeper.js";

/* The keeper's DECISIONS over one fake machine (testing.ts, fakeKeeper): when it runs `ic sandbox fix` and about which
   sandbox, how long it waits after a run that left something, when it stays still, and what it logs. No timers, no
   links and no ic: the clock moves only when a test moves it. */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
// A link's URL and the slug ic gives the sandbox behind it: its hostname's first label.
const URL = "https://sandbox-0123456789ab.sbx.intentic.dev";
const SLUG = "sandbox-0123456789ab";

const CLAP_REFUSAL = "error: unrecognized subcommand 'fix'\n\nUsage: ic sandbox <COMMAND>\n\nFor more information, try '--help'.\n";

// A keeper whose sweep is never due, for the tests about one sandbox's link.
const linkOnly = (): KeeperState => ({ ...newKeeperState(NOW), sweepDueAt: Number.POSITIVE_INFINITY });

const setup = (state: KeeperState = newKeeperState(NOW)) => {
    const fake = fakeKeeper(NOW);
    const lines: string[] = [];
    const round = async (at: number): Promise<void> => {
        fake.clock = at;
        await runKeeperRound(state, fake.seams, (line) => lines.push(line));
    };
    return { fake, lines, state, round };
};

test("the keeper asks ic to fix only what needs no yes, in JSON, as the agent: about one sandbox or every one", () => {
    expect(keeperFixArgs()).toEqual(["sandbox", "fix", "--auto", "--json", "--source", "agent"]);
    expect(keeperFixArgs("work")).toEqual(["sandbox", "fix", "work", "--auto", "--json", "--source", "agent"]);
});

test("ic's progress lines and its final verdicts are read out of whatever prose surrounds them", () => {
    const output = [
        'intentic-fix: {"report":{"stage":"fixing","doing":"Starting Docker Desktop","checks":[]}}',
        'intentic-fix: {"slug":"work","stage":"fixing","doing":"Starting the sandbox"}',
        'intentic-fix: {"stage":"checking","checks":[]}',
        "intentic-fix: not json",
        "intentic: Docker Desktop is starting…",
        '{"slug":"work","report":{"source":"agent","machine":"pc","os":"linux","stage":"done","outcome":"fixed","checks":[{"id":"docker-app","label":"Docker Desktop","state":"ok","fix":"auto"}]}}',
        '{"slug":"other"}',
        '{"slug":"new","report":{"stage":"done","outcome":"rebooting","checks":[{"id":"gpu","label":"GPU","state":"sleepy"}]}}',
    ].join("\n");
    expect(output.split("\n").map(fixProgress)).toEqual([
        { slug: undefined, doing: "Starting Docker Desktop" },
        { slug: "work", doing: "Starting the sandbox" },
        { slug: undefined, doing: undefined },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
    // A word a newer ic adds (an outcome, a state) is still read, so it is still said.
    expect(fixAnswers(output)).toEqual([
        { slug: "work", report: { stage: "done", outcome: "fixed", checks: [{ id: "docker-app", label: "Docker Desktop", state: "ok", fix: "auto" }] } },
        { slug: "new", report: { stage: "done", outcome: "rebooting", checks: [{ id: "gpu", label: "GPU", state: "sleepy" }] } },
    ]);
});

// An ic from before `sandbox fix` is refused by clap before it prints any JSON: that is "cannot fix yet", not a verdict.
test("a run that exited non-zero having said nothing in JSON is an ic that cannot fix, named by its error line", () => {
    expect(readFixRun({ code: 2, output: CLAP_REFUSAL })).toEqual({ unavailable: "error: unrecognized subcommand 'fix'" });
    expect(readFixRun({ code: 127, output: "This device has no `ic` command." })).toEqual({ unavailable: "This device has no `ic` command." });
    // A run stopped at its deadline, one that said anything in JSON, and one with nothing to fix are all fixes.
    expect(readFixRun({ code: 1, output: "ic did not finish within 8 minutes and was stopped.", timedOut: true })).toEqual({ answers: [] });
    expect(readFixRun(fixRun([{ slug: "work", outcome: "needs-you" }], { code: 1 }))).toEqual({
        answers: [{ slug: "work", report: { stage: "done", outcome: "needs-you", checks: [] } }],
    });
    expect(readFixRun({ code: 0, output: "" })).toEqual({ answers: [] });
});

test("the wait after a run that left something starts at three minutes and doubles up to thirty", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([0, 3, 6, 12, 24, 30, 30].map((minutes) => minutes * MIN));
});

test("a verdict is logged in ic's words: what is left, and who can close it", () => {
    const checks = [
        { id: "docker", label: "Docker", state: "ok" },
        { id: "wsl", label: "WSL", state: "fail", problem: "WSL needs an update", fix: "consent" },
        { id: "disk", label: "Disk", state: "warn", problem: "12 GB free", remedy: "Free some space", fix: "you" },
        { id: "tunnel", label: "Tunnel", state: "fail" },
    ];
    expect(verdictLine({ slug: "work", report: { stage: "done", outcome: "needs-you", checks } })).toBe(
        "keeper work: needs-you — WSL: WSL needs an update (needs your yes: `intentic-machine sandbox fix work`); Disk: 12 GB free (Free some space); Tunnel: fail",
    );
    expect(verdictLine({ slug: "work", report: { stage: "done", outcome: "fixed", checks } })).toBe("keeper work: fixed");
});

// After a reboot Docker Desktop is off: the first look comes half a minute after start, over every sandbox.
test("the first sweep runs half a minute after start and then every five minutes, over every sandbox", async () => {
    const { fake, lines, round } = setup();
    fake.records = ["work"];
    await round(NOW + 30_000 - 1);
    expect(fake.asked).toEqual([]);
    await round(NOW + 30_000);
    expect(fake.asked).toEqual([undefined]);
    await round(NOW + 30_000 + 5 * MIN - 1);
    expect(fake.asked).toEqual([undefined]);
    await round(NOW + 30_000 + 5 * MIN);
    expect(fake.asked).toEqual([undefined, undefined]);
    // A standing "healthy" is said once, not every five minutes.
    expect(lines).toEqual(["keeper work: healthy"]);
});

test("what ic does is logged as it happens, once each, and a sweep that leaves something comes back less often", async () => {
    const { fake, lines, round } = setup();
    fake.fixTakesMs = 2 * MIN;
    fake.answer = async () =>
        await Promise.resolve(
            fixRun(
                [
                    { slug: "work", outcome: "fixed" },
                    { slug: "old", outcome: "needs-you", checks: [{ id: "disk", label: "Disk", state: "fail", problem: "1 GB free", fix: "you" }] },
                ],
                { code: 1, doing: ["Starting Docker Desktop", "Starting Docker Desktop", "Starting the sandbox"] },
            ),
        );
    await round(NOW + 30_000);
    expect(lines).toEqual([
        "keeper: Starting Docker Desktop",
        "keeper: Starting the sandbox",
        "keeper work: fixed",
        "keeper old: needs-you — Disk: 1 GB free — looking again in 3 min",
    ]);
    // The sweep's own wait is measured from when the run ended, and never shorter than its five minutes.
    const ended = NOW + 30_000 + 2 * MIN;
    await round(ended + 5 * MIN - 1);
    expect(fake.asked).toEqual([undefined]);
    await round(ended + 5 * MIN);
    expect(fake.asked).toEqual([undefined, undefined]);
    // Twice in a row: six minutes after this one ended.
    await round(ended + 7 * MIN + 6 * MIN - 1);
    expect(fake.asked).toEqual([undefined, undefined]);
    await round(ended + 7 * MIN + 6 * MIN);
    expect(fake.asked).toEqual([undefined, undefined, undefined]);
});

test("a sandbox of this machine is fixed once its link has failed for a minute, and a link elsewhere never is", async () => {
    const { fake, round } = setup(linkOnly());
    fake.records = [SLUG];
    fake.links = [linkView(URL, NOW - UNREACHABLE_AFTER_MS + 1), linkView("https://sandbox-fedcba987654.sbx.intentic.dev", NOW - 10 * MIN)];
    await round(NOW);
    expect(fake.asked).toEqual([]);
    fake.links = [linkView(URL, NOW - UNREACHABLE_AFTER_MS)];
    await round(NOW);
    expect(fake.asked).toEqual([SLUG]);
    expect(fake.heldDuring).toEqual([[SLUG]]);
});

// ic names a sandbox by its hostname's first label or by the id in it; one reached over loopback runs here either way.
test("a link's sandbox is this machine's by ic's records, its last listing, or having been reached over loopback", async () => {
    const byId = setup(linkOnly());
    byId.fake.records = ["0123456789ab"];
    byId.fake.links = [linkView(URL, NOW - 2 * MIN)];
    await byId.round(NOW);
    expect(byId.fake.asked).toEqual(["0123456789ab"]);

    const byLoopback = setup(linkOnly());
    byLoopback.fake.loopback.add(URL);
    byLoopback.fake.links = [linkView(URL, NOW - 2 * MIN)];
    await byLoopback.round(NOW);
    expect(byLoopback.fake.asked).toEqual([SLUG]);

    // A listing taken while Docker answered still names the sandbox once Docker is down.
    const byListing = setup();
    byListing.fake.listing = [SLUG];
    await byListing.round(NOW + 30_000);
    byListing.fake.listing = new Error("Cannot connect to the Docker daemon");
    byListing.fake.links = [linkView(URL, NOW)];
    await byListing.round(NOW + 30_000 + 2 * MIN);
    expect(byListing.fake.asked).toEqual([undefined, SLUG]);
});

test("a sandbox whose fix left something waits out the ladder, and its link coming back clears the wait", async () => {
    const { fake, lines, round } = setup(linkOnly());
    fake.records = [SLUG];
    fake.links = [linkView(URL, NOW - 2 * MIN)];
    fake.answer = async () =>
        await Promise.resolve(
            fixRun(
                [
                    {
                        slug: SLUG,
                        outcome: "needs-you",
                        checks: [{ id: "docker-app", label: "Docker Desktop", state: "fail", problem: "Docker Desktop is not installed", remedy: "Install Docker Desktop", fix: "you" }],
                    },
                ],
                { code: 1 },
            ),
        );
    await round(NOW);
    await round(NOW + 3 * MIN - 1);
    expect(fake.asked).toEqual([SLUG]);
    await round(NOW + 3 * MIN);
    await round(NOW + 9 * MIN - 1);
    expect(fake.asked).toEqual([SLUG, SLUG]);
    await round(NOW + 9 * MIN);
    expect(fake.asked).toEqual([SLUG, SLUG, SLUG]);
    // The same verdict is said once per stretch.
    expect(lines).toEqual([`keeper ${SLUG}: needs-you — Docker Desktop: Docker Desktop is not installed (Install Docker Desktop) — looking again in 3 min`]);

    fake.links = [linkView(URL)];
    await round(NOW + 10 * MIN);
    fake.links = [linkView(URL, NOW + 10 * MIN)];
    await round(NOW + 11 * MIN);
    expect(fake.asked).toEqual([SLUG, SLUG, SLUG, SLUG]);
});

// A link that stays down while ic finds nothing wrong on this machine is the link's trouble, not the sandbox's.
test("a sandbox ic found healthy is not asked about again for five minutes, however long its link stays down", async () => {
    const { fake, lines, round } = setup(linkOnly());
    fake.records = [SLUG];
    fake.links = [linkView(URL, NOW - 2 * MIN)];
    await round(NOW);
    await round(NOW + 5 * MIN - 1);
    expect(fake.asked).toEqual([SLUG]);
    await round(NOW + 5 * MIN);
    expect(fake.asked).toEqual([SLUG, SLUG]);
    expect(lines).toEqual([`keeper ${SLUG}: healthy`]);
});

test("a fix that gave no verdict about its sandbox (stopped at its deadline) is waited out like any other", async () => {
    const { fake, lines, round } = setup(linkOnly());
    fake.records = [SLUG];
    fake.links = [linkView(URL, NOW - 2 * MIN)];
    fake.fixTakesMs = 8 * MIN;
    fake.answer = async () =>
        await Promise.resolve({
            code: 1,
            timedOut: true,
            output: 'intentic-fix: {"report":{"stage":"fixing","doing":"Starting Docker Desktop","checks":[]}}\nic did not finish within 8 minutes and was stopped.',
        });
    await round(NOW);
    expect(lines).toEqual([
        `keeper ${SLUG}: Starting Docker Desktop`,
        `keeper ${SLUG}: ic gave no verdict (ic did not finish within 8 minutes and was stopped.) — looking again in 3 min`,
    ]);
    await round(NOW + 11 * MIN - 1);
    expect(fake.asked).toEqual([SLUG]);
    await round(NOW + 11 * MIN);
    expect(fake.asked).toEqual([SLUG, SLUG]);
});

test("only one fix runs at a time: a round that finds one under way does nothing", async () => {
    const { fake, state } = setup();
    fake.records = ["work"];
    fake.clock = NOW + 30_000;
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
        reached = resolve;
    });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        open = resolve;
    });
    fake.answer = async (slug): Promise<IcRun> => {
        reached();
        await gate;
        return fixRun([{ slug: slug ?? "work", outcome: "healthy" }]);
    };
    const first = runKeeperRound(state, fake.seams, () => undefined);
    await started;
    await runKeeperRound(state, fake.seams, () => undefined);
    expect(fake.asked).toEqual([undefined]);
    open();
    await first;
    expect(state.fixing).toBe(false);
});

// The probation watch finishes or undoes swaps; the keeper waits for its run rather than racing it.
test("nothing runs while the probation watch is running ic, a swap is moving the sandbox, or a flow of this agent holds it", async () => {
    const { fake, round } = setup();
    fake.records = [SLUG];
    fake.watching = true;
    await round(NOW + 30_000);
    expect(fake.asked).toEqual([]);
    fake.watching = false;
    fake.busy.add("other");
    await round(NOW + 30_000);
    expect(fake.asked).toEqual([]);

    // With a flow under way the sweep waits; a link-triggered fix goes ahead for any sandbox but that flow's.
    fake.links = [linkView(URL, NOW)];
    fake.busy.add(SLUG);
    await round(NOW + 2 * MIN);
    expect(fake.asked).toEqual([]);
    fake.busy.delete(SLUG);
    fake.swapping = [SLUG];
    await round(NOW + 2 * MIN);
    expect(fake.asked).toEqual([]);
    fake.swapping = [];
    await round(NOW + 2 * MIN);
    expect(fake.asked).toEqual([SLUG]);
    fake.busy.clear();
    await round(NOW + 3 * MIN);
    expect(fake.asked).toEqual([SLUG, undefined]);
});

test("the sweep marks every sandbox this machine knows for its length, from the records and the listing", async () => {
    const { fake, round } = setup();
    fake.records = ["work", "other"];
    fake.listing = ["work", "third"];
    await round(NOW + 30_000);
    expect(fake.heldDuring).toEqual([["other", "third", "work"]]);
});

test("the switch stops every run and is said once; turning it back on sweeps at once", async () => {
    const { fake, lines, round } = setup();
    fake.on = false;
    await round(NOW + 30_000);
    await round(NOW + 60_000);
    expect(fake.asked).toEqual([]);
    fake.on = true;
    await round(NOW + 10 * MIN);
    expect(fake.asked).toEqual([undefined]);
    fake.on = false;
    await round(NOW + 11 * MIN);
    fake.on = new SyntaxError("machine.json: Unexpected token");
    await round(NOW + 20 * MIN);
    await round(NOW + 21 * MIN);
    expect(fake.asked).toEqual([undefined]);
    expect(lines).toEqual([
        "keeper: off on this machine. `intentic-machine sandbox keeper on` turns it on.",
        "keeper: switched on, looking at this machine's sandboxes now.",
        "keeper: switched off. `intentic-machine sandbox keeper on` turns it back on.",
        "keeper: not running while machine.json does not read — machine.json: Unexpected token",
    ]);
});

// Until the ic under this agent has `sandbox fix`, the keeper must neither loop nor fill the log.
test("an ic that cannot fix is said once and asked again on the ladder, links or not", async () => {
    const { fake, lines, round } = setup();
    fake.records = [SLUG];
    fake.links = [linkView(URL, NOW - 10 * MIN)];
    fake.answer = async () => await Promise.resolve({ code: 2, output: CLAP_REFUSAL });
    const first = NOW + 30_000;
    await round(first);
    await round(first + 3 * MIN - 1);
    expect(fake.asked).toEqual([undefined]);
    await round(first + 3 * MIN);
    expect(fake.asked).toEqual([undefined, SLUG]);
    await round(first + 9 * MIN - 1);
    expect(fake.asked).toEqual([undefined, SLUG]);
    await round(first + 9 * MIN);
    expect(fake.asked).toEqual([undefined, SLUG, undefined]);
    expect(lines).toEqual([
        "keeper: this machine's ic cannot fix sandboxes (error: unrecognized subcommand 'fix'); trying again in 3 min, and less often after that",
    ]);
});

test("no ic at all is waited out the same way", async () => {
    const { fake, lines, round } = setup();
    fake.answer = async () => await Promise.reject(new Error("This device has no `ic` command."));
    await round(NOW + 30_000);
    expect(lines).toEqual(["keeper: this machine's ic cannot fix sandboxes (This device has no `ic` command.); trying again in 3 min, and less often after that"]);
    expect(fake.heldDuring).toEqual([[]]);
});

test("a run that needs the computer restarted says so once", async () => {
    const { fake, lines, round } = setup();
    fake.answer = async () => await Promise.resolve(fixRun([{ slug: "work", outcome: "needs-you" }], { code: 4 }));
    await round(NOW + 30_000);
    await round(NOW + 30_000 + 10 * MIN);
    expect(lines).toEqual(["keeper work: needs-you — looking again in 3 min", "keeper: this computer needs a restart or a sign-out to finish what ic started."]);
});

// What keeps the agent resident on a machine with no link and no pairing (resident.ts).
test("the sandboxes this machine hosts are the listing's when Docker answers, else ic's records, never a runner", async () => {
    expect(await hostedSlugs(async () => await Promise.resolve(["work", "runner-abc"]), async () => await Promise.resolve(["gone"]))).toEqual(["work"]);
    expect(await hostedSlugs(async () => await Promise.resolve([]), async () => await Promise.resolve(["gone"]))).toEqual([]);
    expect(
        await hostedSlugs(
            async () => await Promise.reject(new Error("Cannot connect to the Docker daemon")),
            async () => await Promise.resolve(["work", "runner-abc"]),
        ),
    ).toEqual(["work"]);
});
