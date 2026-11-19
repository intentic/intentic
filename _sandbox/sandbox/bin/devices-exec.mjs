// THE `devices exec` VERB (2026-11-19, the shinobi-society audit): a command run on one of the owner's computers, in a
// mirror of this checkout kept there. Agents did it by hand. One copied 208 MB of a repository to a Windows laptop with
// `devices copy`, installed rustup, built for nine minutes, copied it all again after a wrong folder layout, and copied
// the results back. Another wrote a protocol for it (copy each changed file, touch its LastWriteTime "or cargo will not
// rebuild", app_start, app_status, copy back, one run at a time) and spent 25 calls and 17 minutes in app_status on 5
// rounds. This is that protocol, once, for any language:
// - what is mirrored is what git tracks plus the untracked files it does not ignore, so build outputs and .git stay
//   behind (outside git: everything but the usual output folders); --include adds an ignored path, --exclude drops one;
// - only files whose bytes changed since the last run travel, they land with fresh modification times so an incremental
//   build rebuilds them, and files deleted here are deleted there (devices-exec-scripts.mjs does the computer's half);
// - the command runs there (PowerShell on Windows, a login sh in a WSL distro and elsewhere) in the folder matching this
//   shell's, its output streamed here, and --fetch brings declared paths back into this checkout;
// - runs on one computer go one at a time, from every conversation of this sandbox.
// The sandbox remembers what the mirror holds (a manifest of content hashes, under ~/.cache/intentic/device-mirrors), and
// the mirror keeps a generation mark. A mirror changed or removed on the computer, or a manifest lost here, shows as a
// mark that does not match, and the run sends everything again. Toolchains on the computer are the project's: a program
// the command needs that is not there is named before anything runs.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STAGE_PREFIX, stageFiles } from "./devices-exec-scripts.mjs";

export const EXEC_USAGE = `  devices exec <device> [--in native|wsl|wsl:<distro>] [--fetch <path>]… [--include <path>]… [--exclude <path>]…
               [--needs <program>]… [--repo <dir>] [--mirror <path there>] [--fresh] [--] <command…>
      Run <command…> on <device> in a mirror of this checkout kept there (also \`gpu-run --on <device>\`, for its GPU).
      The mirror is the repository this shell stands in (or --repo): what git tracks plus untracked files it does not
      ignore, so build outputs and .git stay behind. Each run sends only the files whose bytes changed since the last
      one, with fresh modification times so an incremental build there rebuilds them, and deletes there what was
      deleted here. The command runs in the folder matching this shell's, in PowerShell on Windows and a login sh
      elsewhere (--in wsl: a WSL distro of a Windows PC), its output printed here as it comes; the exit code is its own.
      It is one line for that shell: quote it as one argument when it has quoting of its own.
      --fetch <path>   bring this file or folder back into this checkout afterwards (relative to this shell's folder)
      --include <path> mirror an ignored path too (assets generated here); --exclude <path> leave one behind
      --needs <program> check the computer has it before running (the command's own program is checked anyway)
      --mirror <path>  where the mirror lives there (default: intentic-mirrors/<sandbox>/<repository> in its first
                       allowed folder; in WSL, under the distro's home)
      --fresh          send everything, as the first run does
      Runs on one computer go one at a time: a second waits, saying for whom. Ctrl+C stops the command there.
      Installing a toolchain there (rustup, node, a GPU driver) is the project's to do: a program the command needs
      that is not there is named, with nothing run. Needs the computer's "Run commands" and "Create and change files".`;

// A copy carries at most this much (the contract's FILE_COPY_MAX_BYTES).
const COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// The command line carried beside the run for the computer's switches to judge; the schema's cap on one argument.
const COMMAND_MAX_CHARS = 4000;
const FOLLOW_EVERY_MS = 1000;
const WAIT_EVERY_MS = 3000;
// A run of this command is named so on the computer, which is how the next one knows to wait for it.
const RUN_PREFIX = "exec-";
// Outside git nothing says what is a build output: these folders are, in most projects.
const UNTRACKED_SKIPS = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".gradle", ".next", ".turbo", ".cache"]);
// The mirror's own bookkeeping folder there, never sent from here.
const MARK_DIR = ".intentic-mirror";
const SENTINEL = /^intentic-mirror: (\w+)(?: (.*))?$/;
// A first word that is the shell's own, not a program to look for.
const SHELL_WORDS = new Set(["cd", "exit", "export", "set", "unset", "if", "for", "while", "case", "(", "{", ".", "source", "exec", "env", "time", "nice", "echo", "test", "[", "true", "false", "&", "$env:Path"]);

const LIST_OPTIONS = { "--fetch": "fetch", "--include": "include", "--exclude": "exclude", "--needs": "needs" };
const VALUE_OPTIONS = { "--in": "in", "--repo": "repo", "--mirror": "mirror" };

// The options, the device, and the command: everything from `--` or the first word after the device that is not an option.
const parseExec = (args, die) => {
    const options = { in: "native", fetch: [], include: [], exclude: [], needs: [], fresh: false, help: false };
    let index = 0;
    for (; index < args.length; index += 1) {
        const arg = args[index];
        const list = LIST_OPTIONS[arg];
        const value = VALUE_OPTIONS[arg];
        if (arg === "--") {
            index += 1;
            break;
        } else if (arg === "--fresh" || arg === "--help" || arg === "-h") {
            options[arg === "--fresh" ? "fresh" : "help"] = true;
        } else if (list !== undefined || value !== undefined) {
            const given = args[index + 1] ?? die(`${arg} needs a value`);
            if (list === undefined) {
                options[value] = given;
            } else {
                options[list].push(given);
            }
            index += 1;
        } else if (arg.startsWith("-")) {
            die(`unknown option ${arg}\n\n${EXEC_USAGE}`);
        } else if (options.device === undefined) {
            options.device = arg;
        } else {
            break;
        }
    }
    options.command = args.slice(index).join(" ").trim();
    return options;
};

const posix = (path) => path.split(sep).join("/");

// Whether a relative path climbs out of its root: a segment test, so a folder named `..cache` stays inside. This CLI
// runs standalone from /usr/local/bin, without the workspace's packages, so it cannot take @intentic/base's isInside.
const climbsOut = (rel) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

// A path given from this shell's folder, as the repository-relative path both sides name it by.
const inside = (root, path, what, die) => {
    const rel = relative(root, resolve(path));
    if (rel === "" || climbsOut(rel)) {
        die(`${what} ${path} is not inside ${root}`);
    }
    return posix(rel);
};

const repoRoot = (given) => {
    if (given !== undefined) {
        return resolve(given);
    }
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return top.status === 0 ? top.stdout.trim() : process.cwd();
};

const nameOf = (text) => text.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "repo";

// This sandbox, as its folder on the computer is named: two sandboxes mirroring the same repository there keep apart.
const sandboxName = () => nameOf((process.env.SANDBOX_NAME ?? hostname()).replace(/^intentic-sandbox-/, ""));

// --- where the mirror is, and what runs it ----------------------------------------------------------------------------

const isWindows = (facts) => /windows/i.test(facts.os) && facts.wsl === undefined;

// The shell, the stage folder (always on the computer's own side, where copies land) and the mirror.
const placeOf = (facts, device, options, repo, die) => {
    const windows = isWindows(facts);
    const separator = windows ? "\\" : "/";
    const root = (facts.roots[0] ?? facts.home).replace(/[\\/]+$/, "");
    const base = [root, "intentic-mirrors", sandboxName()].join(separator);
    const stageBase = `${base}${separator}.stage`;
    if (options.in === "native") {
        const shell = windows ? "powershell" : "sh";
        return { shell, windows, separator, stageBase, mirror: options.mirror ?? `${base}${separator}${repo}`, where: `${device} (${facts.os})` };
    }
    const wsl = /^wsl(?::(.+))?$/.exec(options.in);
    if (wsl === null) {
        die(`--in takes native, wsl or wsl:<distro>, not "${options.in}"`);
    }
    const distros = facts.wslDistros ?? [];
    if (!windows || distros.length === 0) {
        die(`${device} has no WSL distro to run in (${facts.os}${facts.wsl === undefined ? "" : `, itself the WSL distro ${facts.wsl.distro}`}): run it there natively`, 1);
    }
    const distro = wsl[1];
    if (distro !== undefined && !distros.includes(distro)) {
        die(`${device} has no WSL distro called ${distro}; it has ${distros.join(", ")}`, 1);
    }
    const mirror = options.mirror ?? `~/intentic-mirrors/${sandboxName()}/${repo}`;
    return { shell: "sh", wsl: true, distro, windows: false, separator, stageBase, mirror, where: `${device} (WSL ${distro ?? "default distro"})` };
};

// What the computer's app_start is asked to start: the stage's script, with the command beside it for its switches.
const startRequest = (place, stage, command, name) => {
    if (place.wsl === true) {
        const distro = place.distro === undefined ? [] : ["-d", place.distro];
        return { program: "wsl.exe", args: [...distro, "--cd", stage, "--exec", "sh", "-l", "./run.sh", command], cwd: stage, env: { WSL_UTF8: "1" }, name };
    }
    if (place.shell === "powershell") {
        const flags = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden"];
        return { program: "powershell.exe", args: [...flags, "-File", `${stage}\\run.ps1`, command], cwd: stage, name };
    }
    return { program: "sh", args: ["-l", `${stage}/run.sh`, command], cwd: stage, name };
};

// --- what is mirrored, by content -------------------------------------------------------------------------------------

const gitListed = (root) => {
    const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return listed.status === 0 ? listed.stdout.toString("utf8").split("\0").filter((path) => path !== "") : undefined;
};

const walked = (root, from, skips, into) => {
    for (const entry of readdirSync(join(root, from), { withFileTypes: true })) {
        const path = from === "" ? entry.name : `${from}/${entry.name}`;
        if (!entry.isDirectory()) {
            into.push(path);
        } else if (!skips.has(entry.name)) {
            walked(root, path, skips, into);
        }
    }
    return into;
};

const excluded = (path, exclude) => exclude.some((gone) => path === gone || path.startsWith(`${gone}/`));

// Every path to mirror, repository-relative: git's list (or the tree), the included paths, less the excluded ones. A
// name with a line break in it is left behind: the lists the computer's script reads are a path a line.
const listedPaths = (root, include, exclude, say) => {
    const paths = new Set(gitListed(root) ?? walked(root, "", UNTRACKED_SKIPS, []));
    for (const path of include) {
        const stats = statSync(join(root, path), { throwIfNoEntry: false });
        const found = stats?.isDirectory() === true ? walked(root, path, new Set([".git"]), []) : stats === undefined ? [] : [path];
        found.forEach((each) => paths.add(each));
    }
    const kept = [...paths].filter((path) => !path.split("/").includes(MARK_DIR) && !path.startsWith(".git/") && !excluded(path, exclude));
    const named = kept.filter((path) => !path.includes("\n"));
    if (named.length < kept.length) {
        say(`▸ left behind ${kept.length - named.length} path(s) with a line break in the name`);
    }
    return named.toSorted();
};

const sha256Of = (path) => {
    const hash = createHash("sha256");
    const fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
};

// One file as the manifest holds it: { size, mtimeMs, sha, x }, its hash reused while size and time are unchanged. A
// link stays a link where the mirror is POSIX; Windows gets the file it points to, and nothing for a link to a folder.
const entryOf = (root, path, cached, links) => {
    const absolute = join(root, path);
    let stats = lstatSync(absolute, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink() === true) {
        if (links) {
            return { size: 0, mtimeMs: 0, sha: `link:${readlinkSync(absolute)}`, x: 0 };
        }
        stats = statSync(absolute, { throwIfNoEntry: false });
    }
    if (stats?.isFile() !== true) {
        return undefined;
    }
    const same = cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && !cached.sha.startsWith("link:");
    return { size: stats.size, mtimeMs: stats.mtimeMs, sha: same ? cached.sha : sha256Of(absolute), x: (stats.mode & 0o111) === 0 ? 0 : 1 };
};

/** What travels: every path that is new or whose bytes or executable bit changed, and every path that is gone. */
export const planOf = (known, current) => {
    const send = [...current].filter(([path, entry]) => known?.get(path)?.sha !== entry.sha || known.get(path)?.x !== entry.x).map(([path]) => path);
    const remove = known === undefined ? [] : [...known.keys()].filter((path) => !current.has(path));
    return { send, remove };
};

// --- what this sandbox remembers of each mirror ------------------------------------------------------------------------

const stateRoot = () => process.env.INTENTIC_DEVICE_MIRRORS ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "intentic", "device-mirrors");

const stateFileOf = (device, place) =>
    join(stateRoot(), `${nameOf(device)}-${createHash("sha256").update(`${place.distro ?? ""}\n${place.wsl === true}\n${place.mirror}`).digest("hex").slice(0, 16)}.json`);

const readState = (path) => {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        // allow(silent-catch): no manifest (a first run, or one lost with the container) is a full send, which the run says
        return { generation: "", files: new Map() };
    }
    const files = new Map(Object.entries(parsed.files ?? {}).map(([file, [size, mtimeMs, sha, x]]) => [file, { size, mtimeMs, sha: String(sha), x }]));
    return { generation: String(parsed.generation ?? ""), files };
};

const writeState = (path, generation, files) => {
    mkdirSync(dirname(path), { recursive: true });
    const part = `${path}.${process.pid}`;
    try {
        // allow(primitive-tiers): a standalone CLI in /usr/local/bin cannot import @intentic/base's writeFileAtomicSync; it removes its own staging file on failure.
        writeFileSync(part, JSON.stringify({ generation, files: Object.fromEntries([...files].map(([file, e]) => [file, [e.size, e.mtimeMs, e.sha, e.x]])) }));
        renameSync(part, path);
    } catch (error) {
        rmSync(part, { force: true });
        throw error;
    }
};

// --- one run at a time per computer -----------------------------------------------------------------------------------

// pid 0 and below name process groups, which kill(…, 0) answers for: never a holder.
const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
};

// What the lock says of its holder. One being written this instant reads as held for a few seconds, then as nobody's.
const holderOf = (path) => {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        // allow(silent-catch): an unreadable lock is judged by its age, and again on the next pass
        return { pid: 0, fresh: Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 5000 };
    }
};

const releaseOnExit = (path, mine) =>
    process.on("exit", () => {
        try {
            if (readFileSync(path, "utf8") === mine) {
                rmSync(path, { force: true });
            }
        } catch {
            // allow(silent-catch): a lock already gone has nothing left to release
        }
    });

// Held from here until this process exits, by every conversation's `devices exec` in this sandbox.
const holdDevice = async (device, command, say) => {
    const dir = join(stateRoot(), "locks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${nameOf(device)}.lock`);
    const mine = JSON.stringify({ pid: process.pid, conversation: process.env.INTENTIC_TURN_OWNER ?? "", command: command.slice(0, 120), since: new Date().toISOString() });
    for (let told = false; ; await sleep(WAIT_EVERY_MS)) {
        try {
            writeFileSync(path, mine, { flag: "wx" });
            releaseOnExit(path, mine);
            return;
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
        const holder = holderOf(path);
        if (holder.fresh !== true && !alive(holder.pid)) {
            rmSync(path, { force: true });
        } else if (!told) {
            told = true;
            const who = holder.conversation ? `conversation ${holder.conversation}` : "another shell here";
            say(`▸ waiting for ${device}: ${who} runs \`${holder.command ?? "…"}\` there${holder.since ? ` (since ${holder.since})` : ""}; runs on one computer go one at a time`);
        }
    }
};

// A run left going on the computer (its shell here killed) is waited for too.
const waitForComputer = async (io, device) => {
    for (let told = false; ; await sleep(WAIT_EVERY_MS)) {
        const { runs } = await io.answered("GET", io.deviceRoute(device, "/apps"));
        const busy = runs.find((run) => run.state === "running" && run.name.startsWith(RUN_PREFIX));
        if (busy === undefined) {
            return;
        }
        if (!told) {
            told = true;
            io.say(`▸ waiting for ${device}: ${busy.id} still runs there; runs on one computer go one at a time (devices stop ${busy.id} --device ${device} ends it)`);
        }
    }
};

// --- carrying the stage over, running it, and following it ------------------------------------------------------------

const scratchDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "devices-exec-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// A file or a folder (as a tar) onto `path` there, asked first with nothing sent so a refusal comes before the bytes.
const putOnto = async (io, device, path, local, kind) => {
    const size = statSync(local).size;
    if (size > COPY_MAX_BYTES) {
        io.die(`the changes come to ${megabytes(size)}, more than one copy carries (${megabytes(COPY_MAX_BYTES)}): leave large paths behind with --exclude`, 1);
    }
    const query = new URLSearchParams({ path, name: basename(local), kind, size: String(size), sha256: await io.hashOf(local) });
    const route = `${io.deviceRoute(device, "/files")}?${query}`;
    await io.answered("POST", `${route}&probe=1`);
    await io.answered("POST", route, { file: local });
};

const tar = (args, what, die) => {
    const done = spawnSync("tar", args, { encoding: "utf8" });
    if (done.status !== 0) {
        die(`could not ${what}: ${done.stderr.trim() || `tar exited ${done.status}`}`);
    }
};

// What the computer's script says, read off its output: the rest is the command's own, printed as it comes.
const reader = (seen, say) => (line) => {
    const text = line.replace(/\r$/, "");
    const said = SENTINEL.exec(text);
    if (said === null) {
        say(text);
        return;
    }
    const [, what, rest = ""] = said;
    if (what === "stale") {
        seen.stale = rest === "" ? "none" : rest;
    } else if (what === "synced") {
        seen.synced = rest.slice(rest.indexOf(" ") + 1);
    } else if (what === "missing") {
        seen.missing = rest.split(" ").filter((tool) => tool !== "");
    } else if (what === "absent") {
        seen.absent.push(rest);
    } else {
        say(`▸ ${rest}`);
    }
};

// Follows the run to its end: { exitCode, said }. Ctrl+C, or this shell ending, stops it there first.
const follow = async (io, device, id, onLine) => {
    let stopping = false;
    const stop = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        io.say(`\n▸ stopping ${id} on ${device}…`);
        void io
            .call("POST", io.deviceRoute(device, "/apps/stop"), { id, why: "interrupt" })
            .catch((error) => io.say(`${device} could not be asked to stop it (${error.message}): devices stop ${id} --device ${device}`))
            .finally(() => process.exit(130));
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, stop);
    }
    for (let since = 0, lost = false; ; await sleep(FOLLOW_EVERY_MS)) {
        const reply = await io.call("GET", io.deviceRoute(device, `/apps/${encodeURIComponent(id)}/output?since=${since}`)).catch((error) => ({ status: 0, text: error.message }));
        if (stopping) {
            continue;
        }
        if (reply.status === 403) {
            io.die(`${io.refusalOf(reply.text)}\n${id} keeps running on ${device}: devices stop ${id} --device ${device} ends it`, 1);
        }
        if (reply.status < 200 || reply.status >= 300) {
            if (!lost) {
                io.say(`▸ lost sight of ${id} for now (${io.refusalOf(reply.text)}); still watching`);
            }
            lost = true;
            continue;
        }
        const output = JSON.parse(reply.text);
        output.lines.forEach(onLine);
        since = output.total;
        lost = false;
        if (output.run?.state === "ended") {
            return { exitCode: output.run.exitCode, said: output.run.said };
        }
    }
};

// One round: the changes packed and carried, the script started, its output followed.
const round = async (io, job) => {
    const { device, place, root, current, known, expect } = job;
    const plan = planOf(known, current);
    const unchanged = plan.send.length === 0 && plan.remove.length === 0 && expect !== "";
    const generation = unchanged ? expect : randomBytes(6).toString("hex");
    const id = `${STAGE_PREFIX}${randomBytes(6).toString("hex")}`;
    const scratch = scratchDir();
    const local = join(scratch, id);
    mkdirSync(local);
    const files = stageFiles(place.shell, { ...job, mirror: place.mirror, generation, expect, remove: plan.remove });
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(local, name), text);
    }
    const bytes = plan.send.reduce((sum, path) => sum + (current.get(path)?.size ?? 0), 0);
    io.say(
        known === undefined
            ? `▸ ${place.where}: sending all ${current.size} files of ${root} (${megabytes(bytes)}) to ${place.mirror}`
            : `▸ ${place.where}: ${plan.send.length} changed (${megabytes(bytes)}), ${plan.remove.length} removed, of ${current.size} files mirrored at ${place.mirror}`,
    );
    const stage = `${place.stageBase}${place.separator}${id}`;
    tar(["-cf", join(scratch, "stage.tar"), "-C", local, "."], "pack the run's stage", io.die);
    await putOnto(io, device, stage, join(scratch, "stage.tar"), "tar");
    if (plan.send.length > 0) {
        const list = join(scratch, "delta.list");
        writeFileSync(list, plan.send.join("\0"));
        tar(["-cf", join(scratch, "delta.tar"), ...(place.windows ? ["-h"] : []), "-C", root, "--null", "-T", list], "pack the changes", io.die);
        await putOnto(io, device, stage, join(scratch, "delta.tar"), "file");
    }
    const started = await io.answered("POST", io.deviceRoute(device, "/apps"), startRequest(place, stage, job.command, nameOf(`${RUN_PREFIX}${job.repo}`)));
    if (started.id === undefined) {
        io.die(`${device} did not start it: ${started.text}`, 1);
    }
    io.say(`▸ runs there as ${started.id}: ${job.command}`);
    const seen = { stale: undefined, synced: undefined, missing: [], absent: [] };
    const ended = await follow(io, device, started.id, reader(seen, io.say));
    return { ...seen, ...ended, generation, stage };
};

// The folders set aside there, copied back into this checkout.
const fetchBack = async (io, device, outcome, root, fetch) => {
    for (const path of outcome.absent) {
        io.say(`▸ ${path} was not there after the run: nothing to fetch`);
    }
    const found = fetch.filter((path) => !outcome.absent.includes(path));
    if (found.length === 0) {
        return;
    }
    const part = join(scratchDir(), "out.tar");
    const query = new URLSearchParams({ path: `${outcome.stage}${outcome.separator}out` });
    const got = await io.download(`${io.deviceRoute(device, "/files")}?${query}`, part).catch((error) => io.die(`the daemon could not be reached: ${error.message}`));
    if (got.received !== got.size || got.kind !== "tar") {
        io.die(`the fetch from ${device} was cut after ${got.received} of ${got.size} bytes: run it again`, 1);
    }
    tar(["-xf", part, "-C", root], "unpack what was fetched", io.die);
    io.say(`▸ fetched into ${root}: ${found.join(", ")}`);
};

const firstProgram = (command) => {
    const words = command.split(/\s+/).filter((word) => word !== "");
    const word = words.find((each) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(each));
    return word !== undefined && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(word) && !SHELL_WORDS.has(word) ? word : undefined;
};

const factsOf = async (io, device) => {
    const reply = await io.call("GET", io.deviceRoute(device, "/facts")).catch((error) => io.die(`the daemon could not be reached: ${error.message}`));
    if (reply.status === 404 && !reply.text.includes(device)) {
        io.die("this sandbox's daemon is older than `devices exec`: update the sandbox, then run it again", 1);
    }
    if (reply.status < 200 || reply.status >= 300) {
        io.die(io.refusalOf(reply.text), 1);
    }
    return JSON.parse(reply.text);
};

// The run as the options ask for it: where, what is mirrored (hashed), and what is checked and fetched.
const jobOf = async (io, options) => {
    const { device, command } = options;
    const root = repoRoot(options.repo);
    const repo = nameOf(basename(root));
    const place = placeOf(await factsOf(io, device), device, options, repo, io.die);
    const relativeCwd = relative(root, process.cwd());
    const subdir = climbsOut(relativeCwd) ? "" : posix(relativeCwd);
    const fetch = options.fetch.map((path) => inside(root, path, "--fetch", io.die));
    const include = options.include.map((path) => inside(root, path, "--include", io.die));
    const exclude = options.exclude.map((path) => inside(root, path, "--exclude", io.die));
    const needs = [...new Set([...options.needs.flatMap((list) => list.split(",")), firstProgram(command)])].filter((tool) => tool !== undefined && tool !== "");
    const statePath = stateFileOf(device, place);
    const state = readState(statePath);
    const current = new Map();
    for (const path of listedPaths(root, include, exclude, io.say)) {
        const entry = entryOf(root, path, state.files.get(path), !place.windows);
        if (entry !== undefined) {
            current.set(path, entry);
        }
    }
    return { device, place, root, repo, current, command, subdir, needs, fetch, statePath, state, fresh: options.fresh || state.generation === "" };
};

const missingSaid = (missing, place, device) =>
    `▸ ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on ${place.where}, as ${place.shell === "powershell" ? "PowerShell" : "a login shell"} there finds programs, so nothing ran. ` +
    `Installing the project's toolchain there is the project's to do: ask the owner, or with their yes install it (run_command on ${device}), then run this again.`;

/** `devices exec`: `io` is the devices command's own door to the daemon (answered, call, download, hashOf, …). */
export const execVerb = async (args, io) => {
    const options = parseExec(args, io.die);
    if (options.help) {
        io.say(EXEC_USAGE);
        return;
    }
    if (options.device === undefined || options.command === "") {
        io.die(`exec takes a device and a command\n\n${EXEC_USAGE}`);
    }
    if (options.command.length > COMMAND_MAX_CHARS) {
        io.die(`the command is ${options.command.length} characters, more than ${COMMAND_MAX_CHARS}: put it in a script in the repository and run that`);
    }
    const job = await jobOf(io, options);
    const { device, place, state } = job;
    await holdDevice(device, job.command, io.say);
    await waitForComputer(io, device);
    let outcome = await round(io, { ...job, known: job.fresh ? undefined : state.files, expect: job.fresh ? "" : state.generation });
    if (outcome.stale !== undefined) {
        io.say(`▸ the mirror on ${device} is not the one this sandbox left there (generation ${outcome.stale}, expected ${state.generation}): sending all of it again`);
        outcome = await round(io, { ...job, known: undefined, expect: "" });
    }
    if (outcome.synced === undefined) {
        io.die(`${device} did not bring the mirror up to date (${outcome.said ?? "no word from it"}); nothing ran there`, 1);
    }
    writeState(job.statePath, outcome.generation, job.current);
    if (outcome.missing.length > 0) {
        io.say(missingSaid(outcome.missing, place, device));
        process.exit(127);
    }
    await fetchBack(io, device, { ...outcome, separator: place.separator }, job.root, job.fetch);
    const code = Number.isInteger(outcome.exitCode) ? outcome.exitCode : 1;
    io.say(`■ ${outcome.said ?? `ended with code ${code}`} on ${place.where}`);
    process.exit(code === 0 && outcome.absent.length > 0 ? 1 : code);
};
