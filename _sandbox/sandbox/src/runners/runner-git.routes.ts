import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerFrom } from "../auth/auth.js";
import { repoGitDir } from "../history/history.js";

// Smart-HTTP git door: one repo's real git dir served for a runner's stock git fetch/push. No protocol lives here, each
// route spawns git's own --stateless-rpc half and moves bytes. Auth is the runner's bearer token; push safety is git's
// own denyCurrentBranch=refuse, so a runner pushes to refs/runner-incoming/<id> instead of the checked-out branch.

// Bounds the whole spawn, not idle time; a stall this long is a dead connection, not a big repository.
const GIT_RPC_TIMEOUT_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

// Which runner is calling, or undefined. Every route below starts here; there is no anonymous read.
const callerRunner = async (services: Services, c: Context): Promise<string | undefined> =>
    await services.runners.verify(bearerFrom(c.req.header("authorization")) ?? "");

// Two parent shapes: a container parent keeps every repo's git dir on /history; a local parent never reshapes the
// user's repos, so git itself is asked where the dir is. Traversal is closed in both arms.
const repoDirOf = async (services: Services, c: Context): Promise<string | undefined> => {
    const repo = decodeURIComponent(c.req.param("repo") ?? "");
    if (repo === "") {
        return undefined;
    }
    const relocated = repoGitDir(services.config.historyRoot, repo);
    try {
        await access(relocated);
        return relocated;
    } catch {
        // Not the container shape; ask git where this repo's dir actually is.
    }
    const root = services.workspace.root;
    const workingDir = repo === "root" ? root : resolve(root, repo);
    if (workingDir !== root && !workingDir.startsWith(`${root}/`)) {
        return undefined;
    }
    try {
        const { stdout } = await execFileAsync("git", ["-C", workingDir, "rev-parse", "--absolute-git-dir"]);
        return stdout.trim() === "" ? undefined : stdout.trim();
    } catch {
        return undefined;
    }
};

// git's length-prefixed pkt-line framing; only ASCII service names pass through, so byteLength stays exact.
const pktLine = (text: string): string => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;

// Forwards the client's protocol-v2 header as an env var to the spawned git, so a v2-capable client stays v2.
const gitEnv = (c: Context): NodeJS.ProcessEnv => {
    const protocol = c.req.header("git-protocol");
    return protocol === undefined ? process.env : { ...process.env, GIT_PROTOCOL: protocol };
};

const rpcArgs = (service: string, gitDir: string, advertise: boolean): string[] => [
    // Stated explicitly though it's the default: a future git or stray config file could move the default.
    ...(service === "git-receive-pack" ? ["-c", "receive.denyCurrentBranch=refuse"] : []),
    service.replace(/^git-/, ""),
    "--stateless-rpc",
    ...(advertise ? ["--advertise-refs"] : []),
    gitDir,
];

// GET /info/refs: opens both flows, service-prefixed per the smart-HTTP spec (a `# service=` pkt-line, a flush, then
// git's advertisement).
export const createRunnerGitRefsRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        if ((await callerRunner(services, c)) === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const service = c.req.query("service") ?? "";
        if (!SERVICES.has(service)) {
            return c.json({ error: "unknown service, this door speaks git smart HTTP" }, 400);
        }
        const gitDir = await repoDirOf(services, c);
        if (gitDir === undefined) {
            return c.json({ error: "no such repository" }, 404);
        }
        const child = spawn("git", rpcArgs(service, gitDir, true), { stdio: ["ignore", "pipe", "pipe"], timeout: GIT_RPC_TIMEOUT_MS, env: gitEnv(c) });
        const header = new TextEncoder().encode(`${pktLine(`# service=${service}\n`)}0000`);
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(header);
                child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
                child.on("close", () => controller.close());
                child.on("error", (err) => controller.error(err));
            },
            cancel: () => {
                child.kill();
            },
        });
        return new Response(body, {
            headers: { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" },
        });
    };

// POST /git-upload-pack or /git-receive-pack: the (optionally gunzipped) body is the client's half; the child's stdout
// streams back the answer.
export const createRunnerGitRpcRoute =
    (services: Services, service: "git-upload-pack" | "git-receive-pack") =>
    async (c: Context): Promise<Response> => {
        const runner = await callerRunner(services, c);
        if (runner === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const gitDir = await repoDirOf(services, c);
        if (gitDir === undefined) {
            return c.json({ error: "no such repository" }, 404);
        }
        const raw = c.req.raw.body;
        if (raw === null) {
            return c.json({ error: "empty request" }, 400);
        }
        const child = spawn("git", rpcArgs(service, gitDir, false), { stdio: ["pipe", "pipe", "pipe"], timeout: GIT_RPC_TIMEOUT_MS, env: gitEnv(c) });
        // Logged only: the refusal itself already reaches the client in-protocol, this is for the daemon's log.
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            if (code !== 0) {
                services.logger.warn({ runner, service, code, stderr: stderr.slice(0, 2000) }, "runner git door: rpc exited non-zero");
            }
        });
        const request = Readable.fromWeb(raw as Parameters<typeof Readable.fromWeb>[0]);
        const inbound = c.req.header("content-encoding") === "gzip" ? request.pipe(createGunzip()) : request;
        inbound.pipe(child.stdin);
        inbound.on("error", () => child.kill());
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
                child.on("close", () => controller.close());
                child.on("error", (err) => controller.error(err));
            },
            cancel: () => {
                child.kill();
            },
        });
        return new Response(body, {
            headers: { "content-type": `application/x-${service}-result`, "cache-control": "no-cache" },
        });
    };
