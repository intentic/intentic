import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// THE `devices exec` COMMAND (bin/devices-exec.mjs) AGAINST A FAKE COMPUTER: a daemon that answers the device routes
// from a folder standing in for the computer's disk, and starts what the command asks for there for real, so the
// computer's own script (bin/devices-exec-scripts.mjs) runs as it would on a Linux machine or in a WSL distro. A Windows
// computer's PowerShell cannot run here: its start is answered as the script would answer it.

const CLI = join(packageRoot(import.meta.url), "bin", "devices");

interface StartRequest {
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly name: string;
    readonly env?: Record<string, string>;
}

interface Run {
    readonly id: string;
    readonly request: StartRequest;
    output: string;
    exitCode: number | undefined;
    child: ChildProcess | undefined;
}

interface Computer {
    readonly disk: string;
    readonly runs: Run[];
    // The members of every delta.tar that reached it, in order.
    readonly deltas: string[][];
    facts: Record<string, unknown>;
    port: number;
    readonly close: () => Promise<void>;
}

// A path as the computer names it, on the folder standing in for its disk: C:\Users\me is <disk>/C/Users/me.
const onDisk = (disk: string, path: string): string =>
    path.startsWith("/") ? path : `${disk}/${path.replace(/^([A-Za-z]):[\\/]/u, "$1/").replaceAll("\\", "/")}`;

const bodyOf = async (request: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
};

// A copy onto the computer, landing as the machine's file-copy lands one: inside a folder that exists, else at the path.
const put = async (computer: Computer, request: IncomingMessage, query: URLSearchParams, response: ServerResponse): Promise<void> => {
    const asked = onDisk(computer.disk, query.get("path") ?? "");
    const target = existsSync(asked) && statSync(asked).isDirectory() ? join(asked, query.get("name") ?? "") : asked;
    if (query.get("probe") === "1") {
        json(response, 200, { path: target });
        return;
    }
    const bytes = await bodyOf(request);
    const part = `${target}.part`;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(part, bytes);
    if (query.get("kind") === "tar") {
        mkdirSync(target, { recursive: true });
        spawnSync("tar", ["-xf", part, "-C", target]);
        spawnSync("rm", ["-f", part]);
    } else {
        spawnSync("mv", [part, target]);
        if (query.get("name") === "delta.tar") {
            computer.deltas.push(spawnSync("tar", ["-tf", target], { encoding: "utf8" }).stdout.split("\n").filter((line) => line !== ""));
        }
    }
    json(response, 200, { path: target });
};

// A folder off the computer, as the daemon streams one: a tar, its kind and size in headers.
const get = (computer: Computer, query: URLSearchParams, response: ServerResponse): void => {
    const folder = onDisk(computer.disk, query.get("path") ?? "");
    if (!existsSync(folder)) {
        json(response, 409, { error: `nothing at ${folder}` });
        return;
    }
    const packed = spawnSync("tar", ["-cf", "-", "-C", folder, "."]).stdout;
    response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-intentic-copy-kind": "tar",
        "x-intentic-copy-size": String(packed.byteLength),
        "x-intentic-copy-path": encodeURIComponent(folder),
        "x-intentic-copy-executable": "0",
    });
    response.end(packed);
};

const finish = (run: Run, output: string, exitCode: number): void => {
    run.output += output;
    run.exitCode = exitCode;
};

// The program the command asks the computer to start, run here: sh as itself, wsl.exe as the sh it hands its argv to,
// in a distro whose home is <disk>/distro; PowerShell answered as its script would, from the vars it was handed.
const start = (computer: Computer, request: StartRequest): Run => {
    const run: Run = { id: `${request.name}-${randomBytes(3).toString("hex")}`, request, output: "", exitCode: undefined, child: undefined };
    computer.runs.push(run);
    const cwd = onDisk(computer.disk, request.cwd);
    if (request.program === "powershell.exe") {
        const vars = readFileSync(join(cwd, "vars.ps1"), "utf8");
        const value = (name: string): string => new RegExp(`^\\$${name} = '(.*)'$`, "mu").exec(vars)?.[1] ?? "";
        finish(run, `intentic-mirror: synced ${value("Generation")} ${value("Mirror")}\nhello from Windows\n`, 0);
        return run;
    }
    const wsl = request.program === "wsl.exe";
    const argv = wsl ? request.args.slice(request.args.indexOf("--exec") + 1) : [request.program, ...request.args];
    const home = join(computer.disk, wsl ? "distro" : "home");
    mkdirSync(home, { recursive: true });
    const child = spawn(argv[0] ?? "", argv.slice(1), { cwd, env: { PATH: process.env["PATH"] ?? "", HOME: home } });
    run.child = child;
    child.stdout.on("data", (chunk: Buffer) => (run.output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (run.output += chunk.toString()));
    child.on("close", (code) => (run.exitCode = code ?? 1));
    return run;
};

// What a run printed after `since` (bytes of whole lines), and how it ended, as GET …/apps/{id}/output answers.
const outputOf = (run: Run, since: number) => {
    const ended = run.exitCode !== undefined;
    const whole = ended ? run.output : run.output.slice(0, run.output.lastIndexOf("\n") + 1);
    const fresh = Buffer.from(whole).subarray(since).toString("utf8");
    const state = ended ? { state: "ended", exitCode: run.exitCode, said: `exited with code ${String(run.exitCode)}` } : { state: "running" };
    return { total: Buffer.byteLength(whole), lines: fresh === "" ? [] : fresh.replace(/\n$/u, "").split("\n"), run: { id: run.id, name: run.request.name, ...state } };
};

const route = async (computer: Computer, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "", "http://x");
    const key = `${request.method ?? ""} ${url.pathname}`;
    const output = /^GET \/devices\/rog\/apps\/([^/]+)\/output$/u.exec(key);
    if (key === "GET /devices/rog/facts") {
        json(response, 200, computer.facts);
    } else if (key === "POST /devices/rog/files") {
        await put(computer, request, url.searchParams, response);
    } else if (key === "GET /devices/rog/files") {
        get(computer, url.searchParams, response);
    } else if (key === "GET /devices/rog/apps") {
        json(response, 200, { device: "rog", runs: computer.runs.map((run) => ({ id: run.id, name: run.request.name, state: run.exitCode === undefined ? "running" : "ended" })) });
    } else if (key === "POST /devices/rog/apps") {
        // SAFETY: the command under test posts a start request as JSON.
        const run = start(computer, JSON.parse((await bodyOf(request)).toString()) as StartRequest);
        json(response, 200, { device: "rog", text: `Started ${run.request.name} as ${run.id} (pid 1).`, id: run.id, ended: false });
    } else if (output !== null) {
        const run = computer.runs.find((each) => each.id === output[1]);
        json(response, run === undefined ? 409 : 200, run === undefined ? { error: "no such run" } : outputOf(run, Number(url.searchParams.get("since") ?? 0)));
    } else if (key === "POST /devices/rog/apps/stop") {
        computer.runs.forEach((run) => run.child?.kill());
        json(response, 200, { device: "rog", stopped: [] });
    } else {
        json(response, 404, { error: `no route ${key}` });
    }
};

const fakeComputer = async (): Promise<Computer> => {
    const disk = await mkdtemp(join(tmpdir(), "devices-exec-disk-"));
    const home = join(disk, "home");
    mkdirSync(home);
    const runs: Run[] = [];
    const deltas: string[][] = [];
    const facts = { device: "rog", os: "Debian GNU/Linux 13 (trixie)", arch: "x64", shell: "/bin/bash", home, roots: [home] };
    const computer: Computer = { disk, runs, deltas, facts, port: 0, close: () => new Promise((done) => server.close(() => done())) };
    const server: Server = createServer((request, response) => void route(computer, request, response));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    computer.port = (server.address() as AddressInfo).port;
    return computer;
};

const git = (cwd: string, ...args: string[]): void => void spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

// A repository with tracked sources, an ignored build output and an untracked file git does not ignore.
const repository = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "devices-exec-repo-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, ".gitignore"), "target/\n");
    writeFileSync(join(root, "src", "main.rs"), "fn main() {}\n");
    writeFileSync(join(root, "README"), "one\n");
    writeFileSync(join(root, "target", "game.bin"), "built\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    writeFileSync(join(root, "notes.txt"), "untracked\n");
    return root;
};

let computer: Computer;
let repo = "";
let state = "";
beforeEach(async () => {
    computer = await fakeComputer();
    repo = await repository();
    state = await mkdtemp(join(tmpdir(), "devices-exec-state-"));
    writeFileSync(join(state, "token"), "token\n");
});
afterEach(async () => {
    await computer.close();
    for (const dir of [computer.disk, repo, state]) {
        await rm(dir, { recursive: true, force: true });
    }
});

const exec = (args: readonly string[], cwd = repo): Promise<{ code: number; out: string }> =>
    new Promise((done) => {
        const child = spawn(process.execPath, [CLI, "exec", "rog", ...args], {
            cwd,
            env: {
                PATH: process.env["PATH"] ?? "",
                HOME: state,
                SANDBOX_PORT: String(computer.port),
                SANDBOX_NAME: "intentic-sandbox-shinobi",
                INTENTIC_AGENT_TOKEN_PATH: join(state, "token"),
                INTENTIC_DEVICE_MIRRORS: join(state, "mirrors"),
            },
        });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", (code) => done({ code: code ?? -1, out }));
    });

// Each run polls the computer once a second, and several run one after another.
const SLOW_MS = 30_000;

const mirrorOf = (): string => join(computer.disk, "home", "intentic-mirrors", "shinobi", repo.split("/").at(-1) ?? "");

test("the first run mirrors what git tracks and does not ignore, and runs the command there with its output and exit code", async () => {
    const ran = await exec(["--", "cat README notes.txt; exit 3"]);
    expect(ran.out).toContain("sending all 4 files");
    expect(ran.out).toContain("one\nuntracked\n");
    expect(ran.code).toBe(3);
    expect(computer.deltas[0]?.toSorted()).toEqual([".gitignore", "README", "notes.txt", "src/main.rs"]);
    expect(existsSync(join(mirrorOf(), "target"))).toBe(false);
    expect(existsSync(join(mirrorOf(), ".git"))).toBe(false);
    // The command's own words ride on the program's command line, where the computer's switches read them.
    expect(computer.runs[0]?.request).toMatchObject({ program: "sh", args: ["-l", expect.stringMatching(/\/\.stage\/run-[0-9a-f]{12}\/run\.sh$/u), "cat README notes.txt; exit 3"] });
}, SLOW_MS);

// The audit's protocol by hand: copy each changed file, touch its LastWriteTime "or cargo will not rebuild".
test("a later run sends only what changed, with a fresh modification time, and deletes there what was deleted here", async () => {
    expect((await exec(["--", "true"])).code).toBe(0);
    const old = Date.now() / 1000 - 3600;
    spawnSync("touch", ["-d", `@${old}`, join(mirrorOf(), "src", "main.rs"), join(mirrorOf(), "README")]);
    writeFileSync(join(repo, "README"), "two\n");
    await rm(join(repo, "notes.txt"));
    const before = Date.now();
    const ran = await exec(["--", "cat README"]);
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining("1 changed (0.0 MB), 1 removed, of 3 files")]);
    expect(ran.out).toContain("two\n");
    expect(computer.deltas[1]).toEqual(["README"]);
    expect(existsSync(join(mirrorOf(), "notes.txt"))).toBe(false);
    expect(statSync(join(mirrorOf(), "README")).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(statSync(join(mirrorOf(), "src", "main.rs")).mtimeMs).toBeLessThan(before - 1000_000);
    // Nothing changed: nothing travels at all.
    expect((await exec(["--", "true"])).out).toContain("0 changed (0.0 MB), 0 removed");
    expect(computer.deltas).toHaveLength(2);
}, SLOW_MS);

test("the command runs in the folder matching this shell's, and --fetch brings a declared result back", async () => {
    const ran = await exec(["--fetch", "out/bench.json", "--", "pwd && mkdir -p out && echo '{\"ms\":3.4}' > out/bench.json"], join(repo, "src"));
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(join(mirrorOf(), "src"));
    expect(readFileSync(join(repo, "src", "out", "bench.json"), "utf8")).toBe('{"ms":3.4}\n');
    expect(ran.out).toContain("fetched into");
    // A declared result that never appeared fails the run, saying so.
    const missing = await exec(["--fetch", "out/none.json", "--", "true"]);
    expect([missing.code, missing.out]).toEqual([1, expect.stringContaining("out/none.json was not there after the run")]);
}, SLOW_MS);

test("a mirror that is not the one this sandbox left there is sent whole again", async () => {
    expect((await exec(["--", "true"])).code).toBe(0);
    await rm(mirrorOf(), { recursive: true, force: true });
    const ran = await exec(["--", "cat README"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("is not the one this sandbox left there (generation none");
    expect(ran.out).toContain("one\n");
    expect(computer.deltas.at(-1)?.toSorted()).toEqual([".gitignore", "README", "notes.txt", "src/main.rs"]);
}, SLOW_MS);

test("a program the command needs that the computer lacks is named, and nothing runs", async () => {
    const ran = await exec(["--needs", "rustc-from-nowhere", "--", "touch ran.txt"]);
    expect(ran.code).toBe(127);
    expect(ran.out).toContain("rustc-from-nowhere is not on rog (Debian GNU/Linux 13 (trixie)), as a login shell there finds programs, so nothing ran");
    expect(existsSync(join(mirrorOf(), "ran.txt"))).toBe(false);
}, SLOW_MS);

test("runs on one computer go one at a time", async () => {
    const first = exec(["--", "sleep 2"]);
    await new Promise((done) => setTimeout(done, 400));
    const second = await exec(["--", "true"]);
    expect(second.out).toContain("waiting for rog");
    expect((await first).code).toBe(0);
    // A lock left by a shell that died is nobody's.
    writeFileSync(join(state, "mirrors", "locks", "rog.lock"), JSON.stringify({ pid: 2_147_483_646, command: "cargo build" }));
    const after = await exec(["--", "true"]);
    expect([after.code, after.out]).toEqual([0, expect.not.stringContaining("waiting for rog")]);
}, SLOW_MS);

test("in a WSL distro the mirror lives in the distro's home, reached through wsl.exe with the stage on the Windows side", async () => {
    computer.facts = { device: "rog", os: "Microsoft Windows 11 Home", arch: "x64", shell: "powershell", home: "C:\\Users\\me", roots: ["C:\\Users\\me"], wslDistros: ["archlinux"] };
    const ran = await exec(["--in", "wsl:archlinux", "--", "cat README"]);
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining("one\n")]);
    expect(computer.runs[0]?.request).toMatchObject({
        program: "wsl.exe",
        args: ["-d", "archlinux", "--cd", expect.stringMatching(/^C:\\Users\\me\\intentic-mirrors\\shinobi\\\.stage\\run-/u), "--exec", "sh", "-l", "./run.sh", "cat README"],
    });
    expect(existsSync(join(computer.disk, "distro", "intentic-mirrors", "shinobi", repo.split("/").at(-1) ?? "", "README"))).toBe(true);
    const refused = await exec(["--in", "wsl:ubuntu", "--", "true"]);
    expect([refused.code, refused.out]).toEqual([1, expect.stringContaining("rog has no WSL distro called ubuntu; it has archlinux")]);
}, SLOW_MS);

test("on Windows itself the run is PowerShell's script, with vars it reads whatever the code page", async () => {
    computer.facts = { device: "rog", os: "Microsoft Windows 11 Home", arch: "x64", shell: "powershell", home: "C:\\Users\\me", roots: ["C:\\Users\\me"] };
    const ran = await exec(["--", "cargo build --release"]);
    expect([ran.code, ran.out]).toEqual([0, expect.stringContaining("hello from Windows")]);
    const request = computer.runs[0]?.request;
    expect(request).toMatchObject({ program: "powershell.exe", args: expect.arrayContaining(["-File", expect.stringMatching(/\\run\.ps1$/u), "cargo build --release"]) });
    const stage = onDisk(computer.disk, request?.cwd ?? "");
    expect(readFileSync(join(stage, "vars.ps1"), "utf8")).toMatch(/^\uFEFF\$Mirror = 'C:\\Users\\me\\intentic-mirrors\\shinobi\\/u);
    expect(readFileSync(join(stage, "needs"), "utf8")).toBe("cargo\n");
    expect(readFileSync(join(stage, "command"), "utf8")).toBe("cargo build --release\n");
}, SLOW_MS);
