import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import {
    CapabilityConnectableSchema,
    type NeedRaised,
    NeedRaiseSchema,
    NeedsListSchema,
    NeedSchema,
    SecretGeneratedSchema,
    SecretGenerateSchema,
    sandboxRequestFor,
} from "@intentic/sandbox-contract";

// The asking commands against the contract itself: each request a CLI sends must be the route the contract declares
// (method, path) with a body its input schema takes, and each answer shaped by the output schema must print and exit as
// promised. On 2026-09-21 a field rename on the daemon's side left `capabilities list` printing "No capability cards are
// available." and `capabilities request` refusing every ask, for days, with every suite green: this is what reads for it.

const BIN = join(packageRoot(import.meta.url), "bin");

interface Seen {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: unknown;
}

interface Daemon {
    readonly port: number;
    readonly seen: Seen[];
    answer: (seen: Seen) => { readonly status: number; readonly body: unknown };
    readonly close: () => Promise<void>;
}

const daemon = async (): Promise<Daemon> => {
    const seen: Seen[] = [];
    const state: { answer: Daemon["answer"] } = { answer: () => ({ status: 500, body: { message: "unanswered" } }) };
    const server: Server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
        });
        request.on("end", () => {
            // Only what a command sent: anything else on this machine may probe a fresh port (a sandbox's own port
            // scanner asks every listener `GET /`), and a probe recorded here reads as a request the command made.
            if (request.headers["x-intentic-agent"] === undefined) {
                response.writeHead(404);
                response.end();
                return;
            }
            const entry: Seen = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: raw === "" ? undefined : JSON.parse(raw) };
            seen.push(entry);
            const { status, body } = state.answer(entry);
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        port,
        seen,
        get answer() {
            return state.answer;
        },
        set answer(next) {
            state.answer = next;
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
};

const TOKEN_DIR = mkdtempSync(join(tmpdir(), "needs-cli-"));
const TOKEN = join(TOKEN_DIR, "agent.token");
writeFileSync(TOKEN, "agent-token-for-the-suite\n");

const run = (port: number, command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(process.execPath.endsWith("bun") ? "node" : process.execPath, [join(BIN, command), ...args], {
            env: { ...process.env, SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_PATH: TOKEN, INTENTIC_TURN_OWNER: "conv-cli" },
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

const OPEN_NEED = NeedSchema.parse({
    id: "need-a1b2c",
    conversationId: "conv-cli",
    subject: { kind: "secret", name: "OPENAI_API_KEY" },
    title: "The OPENAI_API_KEY secret",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
});

// The route a procedure is declared at, as the contract resolves it for this input.
const declared = (procedure: readonly [string, string], input: unknown): string => {
    const route = sandboxRequestFor(procedure, input);
    return `${route?.method} ${route?.path}`;
};

const raised = (answer: NeedRaised) => (seen: Seen) =>
    `${seen.method} ${seen.path}` === declared(["needs", "ask"], seen.body) ? { status: 200, body: answer } : { status: 404, body: { message: `nothing at ${seen.path}` } };

describe("the asking commands speak the needs contract", () => {
    let server: Daemon;
    beforeAll(async () => {
        server = await daemon();
    });
    afterAll(async () => {
        await server.close();
    });
    beforeEach(() => {
        server.seen.length = 0;
    });

    it("capabilities request sends the capability ask the route declares, and exits 0 when it is met", async () => {
        server.answer = raised({ state: "met", message: 'GitHub is connected as "github" and this turn has it: use it.' });
        const result = await run(server.port, "capabilities", [
            "request",
            "website",
            "--target",
            "github.com",
            "--set",
            "purpose=submit the resource form",
            "--why",
            "the list requires its web form",
            "--wait",
            "5",
        ]);
        expect(result).toMatchObject({ code: 0, stdout: 'GitHub is connected as "github" and this turn has it: use it.\n' });
        const [request] = server.seen;
        expect(NeedRaiseSchema.parse(request?.body)).toEqual({
            ask: { kind: "capability", entry: "website", target: "github.com", set: { purpose: "submit the resource form" } },
            why: "the list requires its web form",
            wait: 5,
        });
        expect(request?.headers["x-intentic-agent"]).toBe("agent-token-for-the-suite");
        expect(request?.headers["x-intentic-conversation"]).toBe("conv-cli");
    });

    it("capabilities request --reconnect asks for a new credential, and exits 3 while it is still open", async () => {
        server.answer = raised({ state: "open", message: "Asked a person: Reconnect Komodo.", need: OPEN_NEED });
        const result = await run(server.port, "capabilities", ["request", "komodo", "--reconnect", "--why", "401 Invalid user credentials"]);
        expect(result.code).toBe(3);
        expect(NeedRaiseSchema.parse(server.seen[0]?.body).ask).toEqual({ kind: "capability", entry: "komodo", reconnect: true });
    });

    it("a refusal exits 1 with the daemon's sentence on stdout", async () => {
        server.answer = raised({ state: "refused", code: "unknown_capability", message: 'No catalog entry or connection is named "notion".' });
        const result = await run(server.port, "capabilities", ["request", "notion"]);
        expect(result).toMatchObject({ code: 1, stdout: 'No catalog entry or connection is named "notion".\n' });
    });

    it("capabilities list prints the entries and the workspace's suggestions as the route answers them", async () => {
        const body = CapabilityConnectableSchema.parse({
            entries: [
                { entry: "github", name: "GitHub", description: "Issues, PRs, code search and git.", connected: true },
                { entry: "gitlab", name: "GitLab", description: "Issues, merge requests and pipelines.", connected: false },
            ],
            suggested: [{ entry: "gitlab", claim: "This repository's pipeline runs on GitLab.", evidence: ".gitlab-ci.yml" }],
        });
        server.answer = (seen) => (seen.method === "GET" && seen.path === "/capabilities/connectable" ? { status: 200, body } : { status: 404, body: {} });
        const result = await run(server.port, "capabilities", ["list"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            [
                "[connected] github — GitHub: Issues, PRs, code search and git.",
                "gitlab — GitLab: Issues, merge requests and pipelines.",
                "",
                "This workspace looks like it wants:",
                "  gitlab — This repository's pipeline runs on GitLab. (from .gitlab-ci.yml)",
                "",
            ].join("\n"),
        );
    });

    it("secrets ask sends the secret ask with where it goes and where to get one", async () => {
        server.answer = raised({ state: "open", message: "Asked a person: The OPENAI_API_KEY secret.", need: OPEN_NEED });
        const result = await run(server.port, "secrets", [
            "ask",
            "OPENAI_API_KEY",
            "--where",
            "the Authorization header to api.openai.com",
            "--link",
            "https://platform.openai.com/api-keys",
            "--hint",
            "starts with sk-",
            "--why",
            "the eval script calls the model",
        ]);
        expect(result.code).toBe(3);
        expect(NeedRaiseSchema.parse(server.seen[0]?.body)).toEqual({
            ask: {
                kind: "secret",
                name: "OPENAI_API_KEY",
                where: "the Authorization header to api.openai.com",
                link: "https://platform.openai.com/api-keys",
                hint: "starts with sk-",
            },
            why: "the eval script calls the model",
        });
    });

    it("secrets request raises a release, grants a grant, environment a proposal with the draft's steps", async () => {
        server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
        await run(server.port, "secrets", ["request", "reddit-work", "--why", "post the approved reply"]);
        await run(server.port, "grants", ["request", "folder", "refs/other", "--why", "read the vendored client"]);
        const dir = mkdtempSync(join(tmpdir(), "needs-cli-draft-"));
        const draft = join(dir, "ffmpeg.Dockerfile");
        writeFileSync(draft, "RUN apt-get install -y ffmpeg\n");
        await run(server.port, "environment", ["propose", "ffmpeg", "--file", draft, "--why", "cut the demo video"]);
        expect(server.seen.map((seen) => NeedRaiseSchema.parse(seen.body).ask)).toEqual([
            { kind: "release", subject: "reddit-work" },
            { kind: "grant", subject: "folder", what: "refs/other" },
            { kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg\n" },
        ]);
    });

    it("secrets generate asks the route the contract declares and prints the reference, never a value", async () => {
        const body = { key: "SESSION_SECRET", bytes: 48, format: "alnum" as const };
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["secrets", "generate"], seen.body)
                ? { status: 200, body: SecretGeneratedSchema.parse({ key: "SESSION_SECRET", length: 65, stored: "sandbox" }) }
                : { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        const result = await run(server.port, "secrets", ["generate", "SESSION_SECRET", "--bytes", "48", "--format", "alnum"]);
        expect(result).toMatchObject({
            code: 0,
            stdout:
                "Stored a new random secret as SESSION_SECRET (65 characters). Write {{secret:SESSION_SECRET}} wherever it goes: " +
                "a command substitutes it at execution, and in a file keep the reference itself.\n",
        });
        expect(SecretGenerateSchema.parse(server.seen[0]?.body)).toEqual(body);
    });

    it("secrets generate with no options leaves the length and the alphabet to the daemon's defaults", async () => {
        server.answer = () => ({ status: 200, body: SecretGeneratedSchema.parse({ key: "WEBHOOK_SECRET", length: 64, stored: "env" }) });
        const result = await run(server.port, "secrets", ["generate", "WEBHOOK_SECRET"]);
        expect(result.code).toBe(0);
        expect(server.seen[0]?.body).toEqual({ key: "WEBHOOK_SECRET" });
    });

    it("secrets generate hands back the daemon's sentence for a name something already holds, and exits 1", async () => {
        server.answer = () => ({ status: 409, body: { message: '"SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.' } });
        const taken = await run(server.port, "secrets", ["generate", "SESSION_SECRET"]);
        expect(taken).toMatchObject({ code: 1, stdout: "", stderr: 'secrets: "SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.\n' });
        expect(server.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([declared(["secrets", "generate"], { key: "SESSION_SECRET" })]);
    });

    it("needs lists this conversation's needs and cancel withdraws one, at the routes the contract declares", async () => {
        server.answer = (seen) => {
            if (`${seen.method} ${seen.path}` === declared(["needs", "mine"], undefined)) {
                return { status: 200, body: NeedsListSchema.parse({ needs: [OPEN_NEED] }) };
            }
            if (`${seen.method} ${seen.path}` === declared(["needs", "withdraw"], { id: "need-a1b2c" })) {
                return { status: 200, body: { ...OPEN_NEED, status: "cancelled" } };
            }
            return { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        };
        const listed = await run(server.port, "needs", []);
        expect(listed).toMatchObject({ code: 0, stdout: "need-a1b2c  open      The OPENAI_API_KEY secret\n" });
        const cancelled = await run(server.port, "needs", ["cancel", "need-a1b2c"]);
        expect(cancelled).toMatchObject({ code: 0, stdout: "need-a1b2c is cancelled: The OPENAI_API_KEY secret.\n" });
    });

    it("refuses an option it does not know rather than asking for the wrong thing", async () => {
        const result = await run(server.port, "capabilities", ["request", "github", "--targte", "github.com"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("capabilities: unknown option --targte\n");
        expect(server.seen).toEqual([]);
    });
});
