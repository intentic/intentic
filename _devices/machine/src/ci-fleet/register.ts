import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { CiRunner, CiRunnerRegisterArgs, CiRunnerRemoveArgs } from "@intentic/sandbox-contract/schemas/ci-fleet";
import { z } from "zod";
import type { FleetContext } from "./context.js";
import { answered } from "./sys.js";

/* REGISTERING AND REMOVING A RUNNER, as docs/ops/ci-runner.md's "Registering a runner" did it by hand: the runner release
   downloaded and checked against the SHA-256 its own release notes publish, unpacked into `<home>/actions-runner-<name>`
   as the runner's account, `config.sh` run there as that account with the registration token GitHub minted for the
   sandbox (it lives an hour and is never written down), and the runner's own `svc.sh` installing and starting its unit.
   The release is the one the computer's runners already run where one says its version (each self-updates from there),
   else the newest. Removal is the same in reverse: refused while the runner works a job, its unit stopped and
   uninstalled, `config.sh remove` with GitHub's removal token, and its folder moved into the service's trash, which the
   janitor empties. */

const GITHUB_API = "https://api.github.com/repos/actions/runner/releases";
const FETCH_MS = 60_000;
// The tarball is about 200 MB: minutes on a home connection.
const DOWNLOAD_MS = 8 * 60_000;
// config.sh talks to GitHub; svc.sh to systemd.
const CONFIGURE_MS = 3 * 60_000;

export interface RunnerRelease {
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
}

// What the register step fetches from the network, a seam so a test hands back a release without one.
export interface ReleaseSource {
    readonly release: (version: string | undefined, arch: string) => Promise<RunnerRelease>;
    readonly download: (url: string) => Promise<Uint8Array>;
}

// The two fields of a GitHub release this reads; anything else in it is ignored, and a field of another type reads as absent.
const ReleaseNotesSchema = z.object({ tag_name: z.string().catch(""), body: z.string().catch("") });

const githubJson = async (url: string): Promise<z.infer<typeof ReleaseNotesSchema>> => {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "intentic-machine" }, signal: AbortSignal.timeout(FETCH_MS) });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    const parsed = parseJsonWith(await response.text(), ReleaseNotesSchema);
    if (parsed === undefined) {
        throw new Error(`${url} answered with something other than a release`);
    }
    return parsed;
};

// The runner's own release notes carry each tarball's SHA-256 between `<!-- BEGIN SHA linux-x64 -->` markers.
export const shaFromNotes = (body: string, arch: string): string | undefined =>
    new RegExp(`<!-- BEGIN SHA linux-${arch} -->([0-9a-f]{64})<!-- END SHA linux-${arch} -->`, "u").exec(body)?.[1];

const githubReleases: ReleaseSource = {
    release: async (version, arch) => {
        const notes = await githubJson(version === undefined ? `${GITHUB_API}/latest` : `${GITHUB_API}/tags/v${version}`);
        const tag = notes.tag_name.replace(/^v/u, "");
        const sha256 = shaFromNotes(notes.body, arch);
        if (!/^\d+\.\d+\.\d+$/u.test(tag) || sha256 === undefined) {
            throw new Error(`the actions/runner release ${tag || "(latest)"} names no SHA-256 for linux-${arch}, so its tarball cannot be checked`);
        }
        return { version: tag, sha256, url: `https://github.com/actions/runner/releases/download/v${tag}/actions-runner-linux-${arch}-${tag}.tar.gz` };
    },
    download: async (url) => {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_MS) });
        if (!response.ok) {
            throw new Error(`${url} answered ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    },
};

const runnerArch = (): string => (process.arch === "arm64" ? "arm64" : "x64");

// The account the new runner runs as: the one asked for, else the one most of this computer's runners run as, else the
// account the service was installed for.
export const accountFor = (asked: string | undefined, runners: readonly CiRunner[], fallback: string): string => {
    if (asked !== undefined) {
        return asked;
    }
    const counts = new Map<string, number>();
    for (const runner of runners) {
        if (runner.user !== "root" && runner.user !== "") {
            counts.set(runner.user, (counts.get(runner.user) ?? 0) + 1);
        }
    }
    return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
};

// `getent passwd <user>`: `name:x:uid:gid:gecos:home:shell`.
export const homeOf = (passwd: string): string | undefined => passwd.trim().split(":")[5];

const asUser = (user: string, command: readonly string[]): string[] => ["-u", user, "--", ...command];

const configArgs = (args: CiRunnerRegisterArgs): string[] => [
    "./config.sh",
    "--unattended",
    "--url",
    args.url,
    "--token",
    args.token,
    "--name",
    args.name,
    "--labels",
    args.labels.join(","),
    "--work",
    "_work",
];

// The token is on config.sh's command line, as setup-linux-runner.sh passed it; it is said nowhere else.
const redacted = (text: string, token: string): string => text.replaceAll(token, "<token>");

const unpack = async (context: FleetContext, source: ReleaseSource, release: RunnerRelease, dir: string, user: string): Promise<void> => {
    const bytes = await source.download(release.url);
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== release.sha256) {
        throw new Error(`the downloaded runner v${release.version} is not the one its release published (SHA-256 ${sum}, its notes say ${release.sha256})`);
    }
    const tarball = join(context.config.stateDir, `actions-runner-${release.version}.tar.gz`);
    await writeFile(tarball, bytes, { mode: 0o644 });
    try {
        await mkdir(dir, { mode: 0o755 });
        answered(`chown ${user} ${dir}`, await context.sys.run("chown", [`${user}:`, dir]));
        answered(`tar into ${dir}`, await context.sys.run("runuser", asUser(user, ["tar", "-xzf", tarball, "-C", dir]), { timeoutMs: CONFIGURE_MS }));
    } finally {
        await rm(tarball, { force: true });
    }
};

/** A new runner on this computer, registered to `args.url` under `args.name`, its unit installed and started. */
export const registerRunner = async (context: FleetContext, args: CiRunnerRegisterArgs, source: ReleaseSource = githubReleases): Promise<string> => {
    const release = context.busy.hold();
    try {
        const { runners } = await context.discover();
        if (runners.some((runner) => runner.name === args.name)) {
            throw new Error(`A runner called "${args.name}" is already on this computer: pick another name, or remove that one first.`);
        }
        const user = accountFor(args.user, runners, context.config.user);
        const home = homeOf(answered(`getent passwd ${user}`, await context.sys.run("getent", ["passwd", user])));
        if (home === undefined || home === "") {
            throw new Error(`No home folder for the account ${user}, where the runner's folder would go.`);
        }
        const dir = join(home, `actions-runner-${args.name}`);
        const existing = await context.sys.list(dir);
        if (existing !== undefined) {
            throw new Error(`${dir} is already there: remove it first, or pick another name.`);
        }
        const known = runners.map((runner) => runner.version).find((version) => version !== undefined);
        const runnerRelease = await source.release(known, runnerArch());
        await unpack(context, source, runnerRelease, dir, user);
        const configured = await context.sys.run("runuser", asUser(user, configArgs(args)), { timeoutMs: CONFIGURE_MS, cwd: dir });
        if (configured.status !== 0) {
            throw new Error(redacted(`config.sh did not register ${args.name}: ${`${configured.stdout}${configured.stderr}`.trim().split(/\r?\n/u).slice(-4).join(" / ")}`, args.token));
        }
        answered(`svc.sh install in ${dir}`, await context.sys.run("./svc.sh", ["install", user], { timeoutMs: CONFIGURE_MS, cwd: dir }));
        answered(`svc.sh start in ${dir}`, await context.sys.run("./svc.sh", ["start"], { timeoutMs: CONFIGURE_MS, cwd: dir }));
        context.log(`register: ${args.name} (runner v${runnerRelease.version}) in ${dir} as ${user}, labels ${args.labels.join(",")}`);
        return `Registered ${args.name} (runner v${runnerRelease.version}) in ${dir}, running as ${user} with labels ${args.labels.join(", ")}.`;
    } finally {
        release();
    }
};

// The folder out of the runners' way, into the trash the janitor empties; removed outright where the trash is on
// another filesystem.
const setAside = async (context: FleetContext, dir: string, name: string): Promise<void> => {
    const trash = join(context.config.stateDir, "trash");
    await mkdir(trash, { recursive: true });
    try {
        await rename(dir, join(trash, `${context.sys.now()}-actions-runner-${name}`));
    } catch (error) {
        context.log(`remove: ${dir} could not be moved to the trash (${errorMessage(error)}); removing it in place`);
        await rm(dir, { recursive: true, force: true });
    }
};

/** A runner off GitHub and off this computer: its unit, its registration and its folder. */
export const removeRunner = async (context: FleetContext, args: CiRunnerRemoveArgs): Promise<string> => {
    const release = context.busy.hold();
    try {
        const { runners } = await context.discover();
        const runner = runners.find((candidate) => candidate.name === args.name);
        if (runner === undefined) {
            throw new Error(`No runner called "${args.name}" on this computer.`);
        }
        if (runner.busy) {
            throw new Error(`${args.name} is running a job: drain it first, then remove it.`);
        }
        if (runner.state !== "not-installed") {
            answered(`svc.sh stop in ${runner.dir}`, await context.sys.run("./svc.sh", ["stop"], { timeoutMs: CONFIGURE_MS, cwd: runner.dir }));
            answered(`svc.sh uninstall in ${runner.dir}`, await context.sys.run("./svc.sh", ["uninstall"], { timeoutMs: CONFIGURE_MS, cwd: runner.dir }));
        }
        const removed = await context.sys.run("runuser", asUser(runner.user, ["./config.sh", "remove", "--token", args.token]), { timeoutMs: CONFIGURE_MS, cwd: runner.dir });
        if (removed.status !== 0) {
            throw new Error(redacted(`config.sh did not remove ${args.name} from GitHub: ${`${removed.stdout}${removed.stderr}`.trim().split(/\r?\n/u).slice(-4).join(" / ")}`, args.token));
        }
        await setAside(context, runner.dir, args.name);
        await context.holds.change((holds) => Object.fromEntries(Object.entries(holds).filter(([name]) => name !== args.name)));
        context.log(`remove: ${args.name} unregistered, its unit and folder gone`);
        return `Removed ${args.name}: unregistered from GitHub, its unit uninstalled, its folder in the fleet's trash.`;
    } finally {
        release();
    }
};
