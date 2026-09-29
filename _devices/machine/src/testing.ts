import { createHash } from "node:crypto";
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
                if (command !== FAKE_SSH) {
                    throw new Error(`the fake runner does not run ${command}`);
                }
                // The alias and ssh's own options are dropped; the remote command is the last argument, run here.
                const remote = args.at(-1) ?? "";
                const program = programOf(remote);
                fake.calls.push(`ssh ${program}`);
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
