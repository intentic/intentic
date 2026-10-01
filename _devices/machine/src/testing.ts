import { createHash } from "node:crypto";
import type { FixCheck, KeeperSeams, LinkView } from "./device/sandbox-rounds/keeper.js";
import type { IcRun } from "./device/tools/sandboxes.js";
import { FETCH_PROGRAM, LISTING_PROGRAM, type ProjectRunner, realProjectRunner, type Spawned } from "./sync/project-remote.js";

// The fakes the copy-first project suites share (this repo's `testing.ts` convention, excluded from the build).
//
// THE SANDBOX IS A LOCAL FOLDER BEHIND A FAKE SSH: every command sent to the alias is run by a local shell, exactly as
// the far side's shell would run it, so the programs project-remote.ts sends (their quoting, their NUL framing, the
// fetch's stream) are the ones under test. MUTAGEN IS A STATE: one session under one name, absent, paused or running,
// which the verbs a bring-back uses move between.

export type FakeSessionState = "absent" | "paused" | "running";

// Which program an ssh call carried, read back out of its base64.
export type SshProgram = "list" | "fetch" | "other";

// One file conflict as `mutagen sync list --template {{json .}}` prints it, this device's side and the sandbox's.
export interface MutagenConflict {
    readonly root: string;
    readonly alphaChanges: readonly MutagenChange[];
    readonly betaChanges: readonly MutagenChange[];
}

interface MutagenChange {
    readonly path: string;
    readonly old: { readonly kind: "file"; readonly digest: string } | null;
    readonly new: { readonly kind: "file"; readonly digest: string };
}

const sha1 = (content: string): string => createHash("sha1").update(content).digest("hex");

const fileEntry = (content: string): MutagenChange["new"] => ({ kind: "file", digest: sha1(content) });

// The conflict Mutagen reports for a file whose sandbox copy changed while it kept this device's: `agreed` is what the
// two held when they last agreed (none for a session that never saw them agree), `here` and `sandbox` each side's now.
export const mutagenConflict = (path: string, contents: { readonly agreed?: string; readonly here: string; readonly sandbox: string }): MutagenConflict => {
    const agreed = contents.agreed === undefined ? null : fileEntry(contents.agreed);
    return {
        root: path,
        alphaChanges: [{ path, old: agreed, new: fileEntry(contents.here) }],
        betaChanges: [{ path, old: agreed, new: fileEntry(contents.sandbox) }],
    };
};

export interface FakeProject {
    readonly runner: ProjectRunner;
    // Every call in order, as `ssh list`, `ssh fetch`, `mutagen pause` and so on, asserted as a transcript.
    readonly calls: string[];
    session: FakeSessionState;
    // Whether a flush finishes its cycle: one against a sandbox that stopped answering never does.
    flushes: boolean;
    // What `sync list` reports as the session's conflicts.
    conflicts: readonly MutagenConflict[];
    // Runs just before the named ssh program does, so a test can change the sandbox's copy in between.
    readonly before: Partial<Record<SshProgram, () => Promise<void>>>;
}

export const FAKE_SSH = "fake-ssh";
// `docker exec` as a docker pairing's bring-back spells it (endpoint.ts remoteShell): the same remote command, handed to
// `sh -c` in the container rather than to ssh's far side, so the very same programs run either way.
export const FAKE_DOCKER = "fake-docker";
export const FAKE_MUTAGEN = "fake-mutagen";

const programOf = (command: string): SshProgram => {
    const encoded = /Buffer\.from\("([A-Za-z0-9+/=]+)","base64"\)/.exec(command)?.[1];
    const program = encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString();
    return program === LISTING_PROGRAM ? "list" : program === FETCH_PROGRAM ? "fetch" : "other";
};

const answered = (status: number, stdout = ""): Spawned => ({
    stdout: (async function* () {
        if (stdout !== "") {
            yield Buffer.from(stdout);
        }
    })(),
    exit: Promise.resolve({ status, stderr: status === 0 ? "" : "fake-mutagen: no such session" }),
});

// One verb of the fake Mutagen: `sync <verb> ... <name>`.
const mutagenVerb = (fake: FakeProject, verb: string): Spawned => {
    fake.calls.push(`mutagen ${verb}`);
    if (fake.session === "absent") {
        return answered(1);
    }
    switch (verb) {
        case "list":
            return answered(0, JSON.stringify([{ name: "fake", paused: fake.session === "paused", conflicts: fake.conflicts }]));
        case "flush":
            return answered(fake.session === "running" && fake.flushes ? 0 : 1);
        case "pause":
            fake.session = "paused";
            return answered(0);
        case "resume":
            fake.session = "running";
            return answered(0);
        default:
            throw new Error(`the fake Mutagen has no \`sync ${verb}\``);
    }
};

export const fakeProject = (session: FakeSessionState = "running"): FakeProject => {
    const fake: FakeProject = {
        calls: [],
        session,
        flushes: true,
        conflicts: [],
        before: {},
        runner: {
            spawn: (command, args, options) => {
                if (command === FAKE_MUTAGEN) {
                    return mutagenVerb(fake, args[1] ?? "");
                }
                if (command !== FAKE_SSH && command !== FAKE_DOCKER) {
                    throw new Error(`the fake runner does not run ${command}`);
                }
                // A docker call is held to the one shape a docker pairing sends, so a test passes only if the remote
                // command really is what `sh -c` in the container is given.
                if (command === FAKE_DOCKER && (args[0] !== "exec" || args.at(-3) !== "sh" || args.at(-2) !== "-c")) {
                    throw new Error(`the fake docker runs only \`exec … sh -c <command>\`, not \`${args.join(" ")}\``);
                }
                // The alias, the container and each transport's own options are dropped; the remote command is the last
                // argument, run here.
                const remote = args.at(-1) ?? "";
                const program = programOf(remote);
                fake.calls.push(`${command === FAKE_DOCKER ? "docker" : "ssh"} ${program}`);
                const hook = fake.before[program];
                if (hook === undefined) {
                    return realProjectRunner.spawn("sh", ["-c", remote], options);
                }
                // Deferred until the hook has run, so the program sees the sandbox as the test left it.
                const started = hook().then(() => realProjectRunner.spawn("sh", ["-c", remote], options));
                return {
                    stdout: (async function* () {
                        yield* (await started).stdout;
                    })(),
                    exit: started.then(async (spawned) => await spawned.exit),
                };
            },
        },
    };
    return fake;
};

/* THE KEEPER'S SEAMS (device/sandbox-rounds/keeper.ts) over one fake machine: a clock that moves only when a test or a
   fix moves it, links whose outages the test sets, ic's records and listing, and an `ic sandbox fix` that prints what
   the real one prints (progress lines, prose, one JSON line per sandbox) and records every run. */

// One sandbox's verdict as a fake run reports it.
export interface FakeVerdict {
    readonly slug: string;
    readonly outcome: string;
    readonly checks?: readonly FixCheck[];
}

// What `ic sandbox fix --json` prints for these verdicts: `doing` progress lines first, a line of prose among them, then
// one report per sandbox in the shape ic posts to the platform.
export const fixRun = (verdicts: readonly FakeVerdict[], { code = 0, doing = [] }: { readonly code?: number; readonly doing?: readonly string[] } = {}): IcRun => ({
    code,
    output: [
        ...doing.map((what) => `intentic-fix: ${JSON.stringify({ report: { stage: "fixing", doing: what, checks: [] } })}`),
        "intentic: checking this machine…",
        ...verdicts.map((verdict) =>
            JSON.stringify({
                slug: verdict.slug,
                report: { source: "agent", machine: "test-pc", os: "linux", stage: "done", outcome: verdict.outcome, checks: verdict.checks ?? [] },
            }),
        ),
    ].join("\n"),
});

export interface FakeKeeper {
    readonly seams: KeeperSeams;
    // Every fix run, by the slug it named (undefined for the sweep over every sandbox), and what was held while it ran.
    readonly asked: (string | undefined)[];
    readonly heldDuring: string[][];
    clock: number;
    // How far the clock moves while a fix runs.
    fixTakesMs: number;
    // The switch, or the error reading machine.json throws.
    on: boolean | Error;
    links: LinkView[];
    records: string[];
    // `ic sandbox list --json`'s slugs, or the error it fails with while Docker is down.
    listing: string[] | Error;
    swapping: string[];
    watching: boolean;
    readonly busy: Set<string>;
    readonly loopback: Set<string>;
    // How the fake ic answers a run; by default every sandbox it was asked about (every record, for the sweep) is healthy.
    answer: (slug: string | undefined) => Promise<IcRun>;
}

// A link to `url` that has been failing since `downSince`, or open when that is undefined.
export const linkView = (url: string, downSince?: number): LinkView =>
    downSince === undefined
        ? { url, reading: { state: "open" } }
        : { url, reading: { state: "connecting", outage: { failures: 3, since: downSince } } };

export const fakeKeeper = (start: number): FakeKeeper => {
    const held = new Set<string>();
    const busy = new Set<string>();
    const loopback = new Set<string>();
    const fake: FakeKeeper = {
        asked: [],
        heldDuring: [],
        clock: start,
        fixTakesMs: 0,
        on: true,
        links: [],
        records: [],
        listing: [],
        swapping: [],
        watching: false,
        busy,
        loopback,
        answer: async (slug) => await Promise.resolve(fixRun((slug === undefined ? fake.records : [slug]).map((each) => ({ slug: each, outcome: "healthy" })))),
        seams: {
            enabled: async () => (fake.on instanceof Error ? await Promise.reject(fake.on) : fake.on),
            fix: async (slug, onLine) => {
                fake.asked.push(slug);
                fake.heldDuring.push([...held].toSorted());
                const run = await fake.answer(slug);
                fake.clock += fake.fixTakesMs;
                for (const line of run.output.split("\n")) {
                    onLine(line);
                }
                return run;
            },
            listing: async () => (fake.listing instanceof Error ? await Promise.reject(fake.listing) : fake.listing),
            records: async () => await Promise.resolve(fake.records),
            swapping: async () => await Promise.resolve(fake.swapping),
            links: () => fake.links,
            loopback,
            watching: () => fake.watching,
            busy,
            hold: (slug) => {
                held.add(slug);
                return () => void held.delete(slug);
            },
            now: () => fake.clock,
        },
    };
    return fake;
};
