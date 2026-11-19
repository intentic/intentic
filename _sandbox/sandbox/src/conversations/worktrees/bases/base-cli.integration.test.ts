import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { sandboxRequestFor } from "@intentic/sandbox-contract";
import { BaseAskSchema, type BaseEnsured, BaseEnsuredSchema } from "@intentic/sandbox-contract/schemas/bases";

// The `base` command against the contract and a stub daemon: what it asks (the route the contract declares, a body its
// input schema takes), where it runs the command, and the exit codes a script reads: the command's own, and 125 when
// there is no base to run it in.

const BIN = join(packageRoot(import.meta.url), "bin", "base");

interface Seen {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: unknown;
}

let server: Server;
let port = 0;
const seen: Seen[] = [];
let answer: (request: Seen) => { readonly status: number; readonly body: unknown } = () => ({ status: 500, body: { message: "unanswered" } });

let root = "";
let checkout = "";
let base = "";
let token = "";

const git = (cwd: string, ...args: string[]): string => {
    const ran = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    expect(ran.status).toBe(0);
    return ran.stdout.trim();
};

beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "base-cli-")));
    checkout = join(root, "checkout");
    base = join(root, "bases", "root", "aaaaaaaaaaaa");
    mkdirSync(join(checkout, "crates", "engine"), { recursive: true });
    mkdirSync(join(base, "crates", "engine"), { recursive: true });
    writeFileSync(join(checkout, "crates", "engine", "lib.rs"), "one\n");
    git(root, "init", "-q", "-b", "main", checkout);
    git(checkout, "add", "-A");
    git(checkout, "commit", "-qm", "one");
    writeFileSync(join(checkout, "crates", "engine", "lib.rs"), "two\n");
    git(checkout, "commit", "-qam", "two");
    token = join(root, "agent.token");
    writeFileSync(token, "agent-token-for-the-suite\n");
    server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
        });
        request.on("end", () => {
            // Only what the command sent: a port scanner's probe is not a request it made.
            if (request.headers["x-intentic-agent"] === undefined) {
                response.writeHead(404);
                response.end();
                return;
            }
            const entry: Seen = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: raw === "" ? undefined : JSON.parse(raw) };
            seen.push(entry);
            const { status, body } = answer(entry);
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    seen.length = 0;
});

const ensured = (overrides: Partial<BaseEnsured> = {}): BaseEnsured =>
    BaseEnsuredSchema.parse({ repo: "root", commit: "a".repeat(40), path: base, holders: ["conv-cli"], usedAt: 1, created: true, warm: [], ...overrides });

// The route a procedure is declared at, as the contract resolves it for this input.
const declared = (procedure: readonly [string, string], input: unknown): string => {
    const route = sandboxRequestFor(procedure, input);
    return `${route?.method} ${route?.path}`;
};

const run = (args: readonly string[], cwd = join(checkout, "crates", "engine")): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(process.execPath.endsWith("bun") ? "node" : process.execPath, [BIN, ...args], {
            cwd,
            env: { ...process.env, SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_FILE: token, INTENTIC_TURN_OWNER: "conv-cli" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

test("base run asks for the fork point of the checkout it stands in, runs there at the same folder, and exits with the command's code", async () => {
    answer = (request) => (`${request.method} ${request.path}` === declared(["bases", "ensure"], request.body) ? { status: 200, body: ensured() } : { status: 404, body: {} });
    const result = await run(["run", "--", "sh", "-c", 'pwd; echo "$INTENTIC_BASE_COMMIT"; exit 3']);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe(`${join(base, "crates", "engine")}\n${"a".repeat(40)}\n`);
    expect(result.stderr).toContain(`base: made root at aaaaaaaaaaaa, ${base}`);
    expect(seen).toHaveLength(1);
    expect(BaseAskSchema.parse(seen[0]?.body)).toEqual({ gitDir: join(checkout, ".git"), head: git(checkout, "rev-parse", "HEAD") });
    expect(seen[0]?.headers["x-intentic-conversation"]).toBe("conv-cli");
});

test("--at resolves the commit where the command stands, and main is left for the daemon to read", async () => {
    answer = () => ({ status: 200, body: ensured({ created: false }) });
    expect((await run(["path", "--at", "HEAD~1"])).stdout).toBe(`${join(base, "crates", "engine")}\n`);
    expect(BaseAskSchema.parse(seen[0]?.body).at).toBe(git(checkout, "rev-parse", "HEAD~1"));
    await run(["path", "--at=main"]);
    expect(BaseAskSchema.parse(seen[1]?.body).at).toBe("main");
    const unknown = await run(["path", "--at", "no-such-ref"]);
    expect({ code: unknown.code, stdout: unknown.stdout }).toEqual({ code: 2, stdout: "base: no-such-ref is not a commit git can find here.\n" });
});

test("no base means 125 and the daemon's reason on stdout, and the command never runs", async () => {
    answer = () => ({ status: 400, body: { message: "The sandbox's disk has 1 GB free." } });
    const result = await run(["run", "sh", "-c", "echo ran"]);
    expect(result).toMatchObject({ code: 125, stdout: "base: The sandbox's disk has 1 GB free.\n" });
});

test("a folder that did not exist at the base's commit is said, not silently swapped for another", async () => {
    answer = () => ({ status: 200, body: ensured() });
    mkdirSync(join(checkout, "crates", "new-one"), { recursive: true });
    const result = await run(["run", "true"], join(checkout, "crates", "new-one"));
    expect(result.code).toBe(125);
    expect(result.stdout).toMatch(/^base: crates\/new-one does not exist at aaaaaaaaaaaa/u);
});

test("a command that cannot be started exits 127, as a shell's would", async () => {
    answer = () => ({ status: 200, body: ensured({ created: false }) });
    expect((await run(["run", "no-such-program-anywhere"])).code).toBe(127);
});

test("drop --all and ls speak their routes", async () => {
    answer = (request) => {
        if (`${request.method} ${request.path}` === declared(["bases", "drop"], request.body)) {
            return { status: 200, body: { released: [base], removed: [base] } };
        }
        return { status: 200, body: { bases: [ensured()] } };
    };
    expect((await run(["drop", "--all"])).stdout).toBe(`${base}: let go of and removed\n`);
    expect(seen[0]?.body).toEqual({ all: true });
    const listed = await run(["ls"]);
    expect(seen[1]).toMatchObject({ method: "GET", path: "/bases" });
    expect(listed.stdout).toContain(`root@aaaaaaaaaaaa  ${base}`);
});
