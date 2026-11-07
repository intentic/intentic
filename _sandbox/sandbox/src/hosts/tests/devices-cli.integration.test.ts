import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { packageRoot } from "@intentic/constants/node";

// THE `devices run` COMMAND AGAINST A DAEMON THAT ONLY RECORDS (bin/devices): while its build compiles, lands into the
// repository are held and the hold is renewed; the run records the commit it was built from and says when the tree
// moved under the build; an agent's run will not replace a run of the target it did not start without --replace.

const CLI = join(packageRoot(import.meta.url), "bin", "devices");

interface Asked {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown> | undefined;
    // Whether the build's output existed when the daemon was asked: a renew asked mid-build sees none yet.
    readonly built: boolean;
}

interface Daemon {
    readonly asked: Asked[];
    readonly port: number;
    readonly close: () => Promise<void>;
}

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown> | undefined> => {
    let raw = "";
    for await (const chunk of request) {
        raw += String(chunk);
    }
    // SAFETY: the command under test sends JSON objects to these routes, or nothing.
    return raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
};

// The routes `devices run` calls, answered as the daemon would, each request kept.
const fakeDaemon = async (repo: string, runs: readonly Record<string, unknown>[]): Promise<Daemon> => {
    const asked: Asked[] = [];
    const answers = new Map<string, unknown>(Object.entries({
        "POST /devices/builds": { held: true, id: "hold-1", repo: "game", renewEveryMs: 40 },
        "POST /devices/builds/hold-1/renew": { held: true },
        "DELETE /devices/builds/hold-1": { released: true, waited: 1, landedDuring: 1 },
        "GET /devices/rog/apps": { device: "rog", runs },
        "POST /devices/rog/apps/stop": { device: "rog", stopped: [] },
        "GET /ports": {
            ports: [
                { port: 7878, kind: "workspace", title: "cargo", origin: "agent", owner: { conversationId: "wise-cinder-95ng", label: "Scratch server" }, forwarded: false },
                { port: 5173, kind: "workspace", title: "Vite", origin: "terminal", forwarded: false },
                { port: 8787, kind: "system", title: "Daemon", origin: "sandbox", forwarded: false },
            ],
        },
        "POST /devices/rog/apps": { device: "rog", text: "Started server as server-abc123 (pid 1) in C:\\runs.", id: "server-abc123", ended: false },
    }));
    const server: Server = createServer((request, response) => {
        void (async () => {
            const path = (request.url ?? "").split("?")[0] ?? "";
            const body = request.headers["content-type"] === "application/json" ? await bodyOf(request) : undefined;
            const built = await readFile(join(repo, "out.txt"), "utf8").then(
                () => true,
                () => false,
            );
            asked.push({ method: request.method ?? "", path, body, built });
            const key = `${request.method ?? ""} ${path}`;
            // The push's probe: this computer already holds the build.
            const answer = path === "/devices/rog/artifacts" ? { path: "C:\\runs\\server\\abc" } : answers.get(key);
            response.writeHead(answer === undefined ? 404 : 200, { "content-type": "application/json" });
            response.end(JSON.stringify(answer ?? { error: `no route ${key}` }));
        })();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    return { asked, port: (server.address() as AddressInfo).port, close: () => new Promise((done) => server.close(() => done())) };
};

const git = (cwd: string, ...args: string[]): string => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

// A repository whose one target builds a file (touching a tracked one while it does, when asked to) and carries it.
const project = async (build: string): Promise<{ root: string; token: string }> => {
    const root = await mkdtemp(join(tmpdir(), "devices-cli-"));
    await mkdir(join(root, STATE_DIR));
    await writeFile(
        join(root, STATE_DIR, "run.json"),
        JSON.stringify({ targets: [{ name: "server", device: "rog", build, artifact: "out.txt" }] }),
    );
    await writeFile(join(root, "src.txt"), "one\n");
    git(root, "init", "-q");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const token = join(root, "..", `${root.split("/").at(-1) ?? ""}.token`);
    await writeFile(token, "token\n");
    return { root, token };
};

const devices = (root: string, token: string, port: number, args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
    new Promise((done) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: root,
            env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_PATH: token, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
            out += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            out += String(chunk);
        });
        child.on("exit", (code) => done({ code: code ?? -1, out }));
    });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

test("a run's build holds lands while it compiles, renews the hold, and records the commit it was built from", async () => {
    // The build changes a tracked file part-way, as a land into the tree would.
    const { root, token } = await project("sleep 0.3; echo moved >> src.txt; echo built > out.txt");
    const daemon = await fakeDaemon(root, []);
    cleanups.push(daemon.close, () => rm(root, { recursive: true, force: true }), () => rm(token, { force: true }));
    const head = git(root, "rev-parse", "HEAD");

    const { code, out } = await devices(root, token, daemon.port, ["run", "server", "--detach"], { INTENTIC_RUN_GRANT: "grant", INTENTIC_RUN_REPO: "game" });

    expect([code, out]).toEqual([0, expect.stringContaining("lands into game wait until this build ends")]);
    const routes = daemon.asked.map(({ method, path }) => `${method} ${path}`);
    const held = routes.indexOf("POST /devices/builds");
    const released = routes.indexOf("DELETE /devices/builds/hold-1");
    expect(daemon.asked[held]?.body).toEqual({ dir: root, target: "server", device: "rog", repo: "game" });
    // Renewed while the build ran, before its output existed; released only once it did, and before anything was pushed.
    expect(daemon.asked.slice(held, released).some(({ path, built }) => path === "/devices/builds/hold-1/renew" && !built)).toBe(true);
    expect(daemon.asked[released]?.built).toBe(true);
    expect(routes.slice(released + 1)).toEqual(["POST /devices/rog/artifacts", "POST /devices/rog/apps/stop", "POST /devices/rog/apps"]);
    expect(out).toContain("1 land(s) waited for this build and go ahead now");
    expect(out).toContain("the tree changed while it compiled (1 land(s) reached it)");
    // The Run view's restart replaces the target's run, and says so on the computer's record.
    expect(daemon.asked.find(({ path }) => path === "/devices/rog/apps/stop")?.body).toEqual({ name: "server", why: "replace" });
    expect(daemon.asked.at(-1)?.body).toMatchObject({ builtFrom: { commit: head, changed: 0, at: expect.any(String), movedDuringBuild: true } });
});

test("an agent's run refuses to replace a run of the target it did not start, until it is told to", async () => {
    const { root, token } = await project("echo built > out.txt");
    const theirs = { id: "server-0f0f0f", name: "server", state: "running", startedBy: "the Run view", builtFrom: { commit: "abcdef0123456789", changed: 0, at: "x" } };
    const daemon = await fakeDaemon(root, [theirs]);
    cleanups.push(daemon.close, () => rm(root, { recursive: true, force: true }), () => rm(token, { force: true }));

    const refused = await devices(root, token, daemon.port, ["run", "server", "--detach"], { INTENTIC_TURN_OWNER: "coral-maple-kmq3" });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("server is already running on rog (server-0f0f0f, started by the Run view, built from abcdef0123)");
    expect(refused.out).toContain("--replace");
    // Nothing was built, held or stopped.
    expect(daemon.asked.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /devices/rog/apps"]);

    const replaced = await devices(root, token, daemon.port, ["run", "server", "--detach", "--replace"], { INTENTIC_TURN_OWNER: "coral-maple-kmq3" });
    expect(replaced.code).toBe(0);
    expect(daemon.asked.some(({ path }) => path === "/devices/rog/apps/stop")).toBe(true);
});

test("devices ports says whose each port is, and which stay off the owner's computers", async () => {
    const { root, token } = await project("true");
    const daemon = await fakeDaemon(root, []);
    cleanups.push(daemon.close, () => rm(root, { recursive: true, force: true }), () => rm(token, { force: true }));
    const { code, out } = await devices(root, token, daemon.port, ["ports"]);
    expect([code, out.split("\n").filter((line) => line !== "")]).toEqual([
        0,
        [
            "5173   Vite  · a terminal of the owner's · mirrored to the owner's computers by desktop sync",
            '7878   cargo  · conversation wise-cinder-95ng, job "Scratch server" · stays in the sandbox',
        ],
    ]);
});
