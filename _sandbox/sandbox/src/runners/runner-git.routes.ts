import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerFrom } from "../auth/auth.js";
import { repoGitDir } from "../history/history.js";

/* THE PARENT'S GIT DOOR, one repository's smart-HTTP pair served straight off its real git dir
 * (<historyRoot>/gits/<encoded id>), for runners to `git fetch` and `git push` against with stock git:
 *
 *   GET  /system/runners/git/:repo/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /system/runners/git/:repo/git-upload-pack
 *   POST /system/runners/git/:repo/git-receive-pack
 *
 * No protocol is implemented here: each route SPAWNS git's own `--stateless-rpc` half and moves bytes, which
 * is the entire trick of smart HTTP and the reason a stale runner and a new parent still converse, the
 * protocol lives in the two git binaries, not in this file.
 *
 * Auth is the runner's own durable token as a bearer, verified against the enrollment store, the same
 * credential its WebSocket hello presents. These routes are exempt from the browser bearer middleware
 * (app.ts) because the caller is a container with no Google identity; they are NOT exempt from auth.
 *
 * Push safety is git's, kept rather than configured away: `receive.denyCurrentBranch=refuse` (stated
 * explicitly, not assumed) refuses any push to a branch checked out in /work or in a conversation's mirror
 * worktree. A runner therefore pushes to refs/runner-incoming/<id> (runner-protocol.ts), and the parent
 * advances the checked-out branch itself by hard-resetting the mirror worktree, the door git sanctions. */

// A push or fetch that stalls this long is a connection that died without closing, not a big repository: the
// pack negotiation itself is chatty, and data flowing resets nothing here, the timer bounds the whole spawn.
const GIT_RPC_TIMEOUT_MS = 10 * 60 * 1000;

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

// Which runner is calling, or undefined. Every route below starts here; there is no anonymous read.
const callerRunner = async (services: Services, c: Context): Promise<string | undefined> =>
    await services.runners.verify(bearerFrom(c.req.header("authorization")) ?? "");

// The repo the URL names, resolved to its git dir, or undefined when this workspace has no such repo. The
// path segment is the URI-ENCODED repo id and repoGitDir re-encodes the decoded name, so a traversal attempt
// ("..%2F..") comes back as a directory name that simply does not exist.
const repoDirOf = async (services: Services, c: Context): Promise<string | undefined> => {
    const repo = decodeURIComponent(c.req.param("repo") ?? "");
    if (repo === "") {
        return undefined;
    }
    const dir = repoGitDir(services.config.historyRoot, repo);
    try {
        await access(dir);
        return dir;
    } catch {
        return undefined;
    }
};

// One pkt-line, git's length-prefixed framing for the advertisement header. Only ASCII service names pass
// through here, so byteLength arithmetic stays byte-exact.
const pktLine = (text: string): string => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;

// git's protocol-v2 opt-in rides a header in smart HTTP and an env var into the spawned half; forwarding it
// is what lets a v2-capable client stay v2. An absent header is protocol v0, which also just works.
const gitEnv = (c: Context): NodeJS.ProcessEnv => {
    const protocol = c.req.header("git-protocol");
    return protocol === undefined ? process.env : { ...process.env, GIT_PROTOCOL: protocol };
};

const rpcArgs = (service: string, gitDir: string, advertise: boolean): string[] => [
    // Stated even though it is the default: this flag is the door's safety story, and a default is a thing a
    // future git or a stray config file can move.
    ...(service === "git-receive-pack" ? ["-c", "receive.denyCurrentBranch=refuse"] : []),
    service.replace(/^git-/, ""),
    "--stateless-rpc",
    ...(advertise ? ["--advertise-refs"] : []),
    gitDir,
];

// GET /info/refs — the ref advertisement that opens both flows, service-prefixed exactly as the smart-HTTP
// spec requires (the `# service=` pkt-line, a flush, then git's own advertisement).
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

// POST /git-upload-pack | /git-receive-pack — the RPC half. The request body (gunzipped when git compressed
// it) is the client's half of the conversation; the child's stdout is the answer, streamed as it is produced.
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
        // stderr is the only place a refused push explains itself; the refusal itself still reaches the
        // client in-protocol, so this is a log line, never the response.
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
