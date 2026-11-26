import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { packageRoot } from "@intentic/constants/node";
import { BUILT_IN_WATCH_KINDS } from "@intentic/sandbox-contract/schemas/automations";
import { CapabilityConnectableSchema, type NeedRaised, NeedRaiseSchema, NeedsListSchema, NeedSchema } from "@intentic/sandbox-contract/schemas/needs";
import {
    type CredentialGate,
    CredentialGatesSchema,
    SecretGeneratedSchema,
    SecretGenerateSchema,
    type SecretHostGuard,
    SecretImportSchema,
    SecretHostGuardsSchema,
    SecretHostGuardSetResultSchema,
    SecretHostGuardSetSchema,
} from "@intentic/sandbox-contract/schemas/secrets";
import { StackGrantRequestSchema } from "@intentic/sandbox-contract/schemas/stack-grants";
import { sandboxRequestFor } from "@intentic/sandbox-contract";

// The asking commands against the contract itself: each request a CLI sends must be the route the contract declares
// (method, path) with a body its input schema takes, and each answer shaped by the output schema must print and exit as
// promised. On 2026-09-21 a field rename on the daemon's side left `capabilities list` printing "No capability cards are
// available." and `capabilities request` refusing every ask, for days, with every suite passing: this is what reads for it.

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

// `stdin`, when given, is piped into the command and closed: what `… | secrets import NAME --stdin` reads.
const run = (port: number, command: string, args: readonly string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(process.execPath.endsWith("bun") ? "node" : process.execPath, [join(BIN, command), ...args], {
            env: { ...process.env, SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_PATH: TOKEN, INTENTIC_TURN_OWNER: "conv-cli" },
        });
        if (stdin !== undefined) {
            child.stdin.end(stdin);
        }
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
        server.answer = (seen) =>
            seen.method === "GET" && seen.path === "/capabilities/connectable" ? { status: 200, body } : { status: 404, body: {} };
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

    it("secrets ask --host proposes each host it goes to once, a URL read as its host", async () => {
        server.answer = raised({ state: "open", message: "Asked a person: The STRIPE_KEY secret.", need: OPEN_NEED });
        const hosts = ["--host", "https://API.stripe.com/v1", "--host", "files.stripe.com", "--host", "api.stripe.com"];
        const result = await run(server.port, "secrets", ["ask", "STRIPE_KEY", ...hosts, "--why", "the billing job charges cards"]);
        expect(result.code).toBe(3);
        expect(NeedRaiseSchema.parse(server.seen[0]?.body)).toEqual({
            ask: { kind: "secret", name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] },
            why: "the billing job charges cards",
        });
    });

    it("secrets ask --multiline asks for a value with lines", async () => {
        server.answer = raised({ state: "open", message: "Asked a person: The DEV_ENV secret.", need: OPEN_NEED });
        const result = await run(server.port, "secrets", ["ask", "DEV_ENV", "--multiline", "--why", "the dev server reads dev.env"]);
        expect(result.code).toBe(3);
        expect(NeedRaiseSchema.parse(server.seen[0]?.body)).toEqual({
            ask: { kind: "secret", name: "DEV_ENV", multiline: true },
            why: "the dev server reads dev.env",
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

    // An opt-in feature pack by name: its fragment is the proposal, read from the packs this package ships, and an
    // image that already bakes it (its stamp holds the pack's content hash) answers at once without asking anyone.
    it("environment propose --pack proposes the pack's own fragment, and answers met when the image bakes it", async () => {
        const packs = join(packageRoot(import.meta.url), "image-packs");
        const stamps = mkdtempSync(join(tmpdir(), "needs-cli-stamps-"));
        const office = readFileSync(join(packs, "office.Dockerfile"), "utf8").trim();
        process.env["INTENTIC_PACKS_DIR"] = packs;
        process.env["INTENTIC_PACK_STAMPS_DIR"] = stamps;
        try {
            server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
            const asked = await run(server.port, "environment", ["propose", "office", "--pack", "--why", "draw the deck to check it"]);
            expect(asked.code).toBe(3);
            expect(NeedRaiseSchema.parse(server.seen[0]?.body)).toEqual({
                ask: { kind: "environment", tool: "office", steps: `${office}\n` },
                why: "draw the deck to check it",
            });
            server.seen.length = 0;
            writeFileSync(join(stamps, "office"), createHash("sha256").update(office).digest("hex"));
            const baked = await run(server.port, "environment", ["propose", "office", "--pack"]);
            expect(baked).toEqual({ code: 0, stdout: "The office pack is already in this image: nothing to propose, use it now.\n", stderr: "" });
            expect(server.seen).toEqual([]);
            const unknown = await run(server.port, "environment", ["propose", "no-such-pack", "--pack"]);
            expect(unknown.code).toBe(2);
            expect(unknown.stdout).toContain("environment: no feature pack named no-such-pack: the packs are ");
        } finally {
            delete process.env["INTENTIC_PACKS_DIR"];
            delete process.env["INTENTIC_PACK_STAMPS_DIR"];
        }
    });

    // A project claim is the owner's to make, so the command only raises the card; the daemon normalises the project.
    it("projects claim asks for the project as given, with the agent's case, and refuses anything but one project", async () => {
        server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
        const asked = await run(server.port, "projects", ["claim", "git@github.com:acme/app.git", "--why", "its bugs are filed from billing"]);
        expect(asked.code).toBe(3);
        expect(server.seen.map((seen) => NeedRaiseSchema.parse(seen.body))).toEqual([
            { ask: { kind: "claim", project: "git@github.com:acme/app.git" }, why: "its bugs are filed from billing" },
        ]);
        server.seen.length = 0;
        expect((await run(server.port, "projects", ["claim"])).code).toBe(2);
        expect((await run(server.port, "projects", ["claim", "github.com/a/b", "github.com/c/d"])).code).toBe(2);
        expect(server.seen).toEqual([]);
    });

    // A message that belongs in another of the person's sandboxes: the command names only where, never the words, and
    // says after the daemon's sentence what each answer means for the turn.
    it("agents redirect asks for the place named, a sandbox or a project, and says what the answer means for the message", async () => {
        server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
        const asked = await run(server.port, "agents", ["redirect", "ops", "--why", "it is about acme/app, which lives in ops"]);
        expect(asked.code).toBe(3);
        expect(asked.stdout).toContain("end your turn now");
        await run(server.port, "agents", ["redirect", "--project", "github.com/acme/app"]);
        expect(server.seen.map((seen) => NeedRaiseSchema.parse(seen.body))).toEqual([
            { ask: { kind: "redirect", target: "ops" }, why: "it is about acme/app, which lives in ops" },
            { ask: { kind: "redirect", project: "github.com/acme/app" } },
        ]);
        server.answer = raised({ state: "refused", message: "Need declined.", need: { ...OPEN_NEED, status: "declined" } });
        const kept = await run(server.port, "agents", ["redirect", "ops"]);
        expect(kept).toMatchObject({ code: 1, stdout: "Need declined.\nThey keep it here: carry on with their message.\n" });
        server.seen.length = 0;
        expect((await run(server.port, "agents", ["redirect"])).code).toBe(2);
        expect((await run(server.port, "agents", ["redirect", "ops", "--project", "github.com/acme/app"])).code).toBe(2);
        expect(server.seen).toEqual([]);
    });

    // A rule the owner stated, named the way the workspace names its file wherever the shell stands: the shared tree, or a
    // conversation's own checkout under the worktrees root.
    it("instructions propose asks for the rule in the workspace's AGENTS.md, a repository's by its folder, from either tree", async () => {
        const before = { workspace: process.env["WORKSPACE_ROOT"], worktrees: process.env["INTENTIC_WORKTREES_ROOT"] };
        process.env["WORKSPACE_ROOT"] = WORKSPACE_ROOT;
        process.env["INTENTIC_WORKTREES_ROOT"] = join(HISTORY_ROOT, "worktrees");
        try {
            server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
            const asked = await run(server.port, "instructions", ["propose", "--text", "  - Don't overdo tests.  ", "--why", "you said it twice"]);
            expect(asked.code).toBe(3);
            await run(server.port, "instructions", ["propose", "--file", join(WORKSPACE_ROOT, "game"), "--text", "Beat Bevy on every case."]);
            await run(server.port, "instructions", ["propose", "--file", join(HISTORY_ROOT, "worktrees", "conv-cli", "game", "AGENTS.md"), "--text", "Port its algorithm if needed."]);
            expect(server.seen.map((seen) => NeedRaiseSchema.parse(seen.body))).toEqual([
                { ask: { kind: "instruction", file: "AGENTS.md", text: "- Don't overdo tests." }, why: "you said it twice" },
                { ask: { kind: "instruction", file: "game", text: "Beat Bevy on every case." } },
                { ask: { kind: "instruction", file: "game/AGENTS.md", text: "Port its algorithm if needed." } },
            ]);
            server.seen.length = 0;
            const outside = await run(server.port, "instructions", ["propose", "--file", "/etc/AGENTS.md", "--text", "x"]);
            expect(outside).toEqual({ code: 2, stdout: `instructions: /etc/AGENTS.md is outside the workspace (${WORKSPACE_ROOT})\n`, stderr: "" });
            const empty = await run(server.port, "instructions", ["propose", "--text", " "]);
            expect(empty).toEqual({ code: 2, stdout: 'instructions: propose needs the rule: --text "…"\n', stderr: "" });
            expect(server.seen).toEqual([]);
        } finally {
            for (const [name, value] of [["WORKSPACE_ROOT", before.workspace], ["INTENTIC_WORKTREES_ROOT", before.worktrees]] as const) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
        }
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
        server.answer = () => ({ status: 200, body: SecretGeneratedSchema.parse({ key: "WEBHOOK_SECRET", length: 64, stored: "sandbox" }) });
        const result = await run(server.port, "secrets", ["generate", "WEBHOOK_SECRET"]);
        expect(result.code).toBe(0);
        expect(server.seen[0]?.body).toEqual({ key: "WEBHOOK_SECRET" });
    });

    it("secrets generate hands back the daemon's sentence for a name something already holds, and exits 2", async () => {
        server.answer = () => ({ status: 409, body: { message: '"SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.' } });
        const taken = await run(server.port, "secrets", ["generate", "SESSION_SECRET"]);
        expect(taken).toMatchObject({ code: 2, stderr: "", stdout: 'secrets: "SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.\n' });
        expect(server.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([declared(["secrets", "generate"], { key: "SESSION_SECRET" })]);
    });

    // A value only the pipe ever carries: found anywhere else, it leaked.
    const MOVED = "s3cret-moved-from-komodo";

    it("secrets import reads the value from stdin, sends it to the route the contract declares, and never prints it", async () => {
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["secrets", "importValue"], seen.body)
                ? { status: 200, body: SecretGeneratedSchema.parse({ key: "KOMODO_DB_PASSWORD", length: MOVED.length, stored: "sandbox" }) }
                : { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        const result = await run(server.port, "secrets", ["import", "KOMODO_DB_PASSWORD", "--stdin"], `${MOVED}\n`);
        expect(result).toEqual({
            code: 0,
            stderr: "",
            stdout:
                `Stored KOMODO_DB_PASSWORD (${MOVED.length} characters). Write {{secret:KOMODO_DB_PASSWORD}} wherever it goes: a command substitutes it at ` +
                "execution, a managed stack's .env receives it once the owner grants it, and in a file keep the reference itself.\n",
        });
        // The one trailing newline a pipe ends with is not part of the value.
        expect(SecretImportSchema.parse(server.seen[0]?.body)).toEqual({ key: "KOMODO_DB_PASSWORD", value: MOVED });
    });

    it("secrets import refuses a name already held with exit 1, and asks nothing without --stdin or a value", async () => {
        server.answer = () => ({ status: 409, body: { message: '"KOMODO_DB_PASSWORD" is already stored: use it as it is, or pick a name nothing here holds.' } });
        const held = await run(server.port, "secrets", ["import", "KOMODO_DB_PASSWORD", "--stdin"], MOVED);
        expect(held).toEqual({ code: 1, stderr: "", stdout: 'secrets: "KOMODO_DB_PASSWORD" is already stored: use it as it is, or pick a name nothing here holds.\n' });
        expect(server.seen).toHaveLength(1);
        const unflagged = await run(server.port, "secrets", ["import", "KOMODO_DB_PASSWORD"], MOVED);
        expect(unflagged).toEqual({
            code: 2,
            stderr: "",
            stdout: "secrets: secrets import takes a NAME and --stdin, with the value piped in: … | secrets import NAME --stdin\n",
        });
        const empty = await run(server.port, "secrets", ["import", "KOMODO_DB_PASSWORD", "--stdin"], "\n");
        expect(empty).toEqual({ code: 2, stderr: "", stdout: "secrets: nothing arrived on stdin: pipe the value in, … | secrets import NAME --stdin\n" });
        expect(server.seen).toHaveLength(1);
        expect(JSON.stringify([held, unflagged, empty])).not.toContain(MOVED);
    });

    it("secrets grant-stack asks the route the contract declares for the stack, the computer and the names, and exits 3 while unanswered", async () => {
        const answer: NeedRaised = { state: "open", message: "Asked the owner to let web on rog receive the secret DB_URL." };
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["stackGrants", "request"], seen.body)
                ? { status: 200, body: answer }
                : { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        const result = await run(server.port, "secrets", ["grant-stack", "shop", "web", "rog", "DB_URL", "API_TOKEN", "--why", "the new release reads DB_URL"]);
        expect(result).toEqual({ code: 3, stderr: "", stdout: "Asked the owner to let web on rog receive the secret DB_URL.\n" });
        expect(StackGrantRequestSchema.parse(server.seen[0]?.body)).toEqual({
            repo: "shop",
            stack: "web",
            device: "rog",
            secrets: ["DB_URL", "API_TOKEN"],
            why: "the new release reads DB_URL",
        });
    });

    it("secrets grant-stack exits 0 when the grant already covers them, 1 when refused, and 2 without a name to grant", async () => {
        server.answer = () => ({ status: 200, body: { state: "met", message: `"web" on "rog" may receive DB_URL.` } satisfies NeedRaised });
        expect(await run(server.port, "secrets", ["grant-stack", "shop", "web", "rog", "DB_URL"])).toEqual({ code: 0, stderr: "", stdout: `"web" on "rog" may receive DB_URL.\n` });
        server.answer = () => ({ status: 200, body: { state: "refused", message: "Nothing was asked: omen is not paired.", code: "invalid_device" } satisfies NeedRaised });
        expect(await run(server.port, "secrets", ["grant-stack", "shop", "web", "omen", "DB_URL"])).toEqual({ code: 1, stderr: "", stdout: "Nothing was asked: omen is not paired.\n" });
        const seen = server.seen.length;
        expect(await run(server.port, "secrets", ["grant-stack", "shop", "web", "rog"])).toEqual({
            code: 2,
            stderr: "",
            stdout: "secrets: secrets grant-stack takes <repo> <stack> <device> and at least one NAME\n",
        });
        expect(server.seen).toHaveLength(seen);
    });

    // A daemon holding these guards and approver gates: the reads answer them, a PUT answers the setting it was sent, with
    // `approvedBy` when given.
    const hostsDaemon =
        (guards: readonly SecretHostGuard[], approvedBy?: string, gates: readonly CredentialGate[] = []): Daemon["answer"] =>
        (seen) => {
            if (`${seen.method} ${seen.path}` === declared(["secrets", "hosts"], undefined)) {
                return { status: 200, body: SecretHostGuardsSchema.parse({ guards }) };
            }
            if (`${seen.method} ${seen.path}` === declared(["secrets", "gates"], undefined)) {
                return { status: 200, body: CredentialGatesSchema.parse({ gates }) };
            }
            if (`${seen.method} ${seen.path}` === declared(["secrets", "setHosts"], seen.body)) {
                const { guard, hosts } = SecretHostGuardSetSchema.parse(seen.body);
                // An absent `approvedBy` parses to undefined and leaves the answer's JSON without it.
                return { status: 200, body: SecretHostGuardSetResultSchema.parse({ guard, hosts, approvedBy }) };
            }
            return { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        };
    const GITHUB: SecretHostGuard = { subject: "GITHUB_TOKEN", kind: "secret", guard: true, hosts: ["api.github.com"], source: "owner" };
    const CONNECTOR: SecretHostGuard = { subject: "github", kind: "capability", guard: true, hosts: ["api.github.com", "github.com"], source: "connector" };
    const STRIPE_OFF: SecretHostGuard = { subject: "STRIPE_KEY", kind: "secret", guard: false, hosts: ["api.stripe.com"], source: "owner" };
    const DATABASE: CredentialGate = { subject: "DATABASE_URL", kind: "secret", approvers: ["bob@corp.com"], scope: "use" };

    it("secrets gates shows each secret's approver and host guard on one line", async () => {
        server.answer = hostsDaemon([GITHUB, CONNECTOR, STRIPE_OFF], undefined, [DATABASE]);
        const result = await run(server.port, "secrets", ["gates"]);
        expect(result).toMatchObject({
            code: 0,
            stdout:
                "DATABASE_URL (secret) — bob@corp.com must release it, again on every use; host guard off: never asks where it goes\n" +
                "GITHUB_TOKEN (secret) — no named approver; host guard on: goes unasked only to api.github.com, anywhere else asks a person\n" +
                "github (connected account) — no named approver; host guard on, its connector's hosts: goes unasked only to api.github.com, github.com, anywhere else asks a person\n" +
                "STRIPE_KEY (secret) — no named approver; host guard off: never asks where it goes (keeps api.stripe.com for when it is turned back on)\n",
        });
    });

    it("secrets gates says nothing needs approval when every guard is off and nobody is named", async () => {
        server.answer = hostsDaemon([STRIPE_OFF]);
        const result = await run(server.port, "secrets", ["gates"]);
        expect(result.stdout.split("\n")[0]).toBe("Nothing here needs a person's approval.");
    });

    it("secrets hosts lists every guard, and a name with none as off", async () => {
        server.answer = hostsDaemon([GITHUB, CONNECTOR]);
        const all = await run(server.port, "secrets", ["hosts"]);
        expect(all).toMatchObject({
            code: 0,
            stdout:
                "GITHUB_TOKEN (secret) — host guard on: goes unasked only to api.github.com, anywhere else asks a person\n" +
                "github (connected account) — host guard on, its connector's hosts: goes unasked only to api.github.com, github.com, anywhere else asks a person\n",
        });
        const vaulted = await run(server.port, "secrets", ["hosts", "github/token"]);
        expect(vaulted.stdout).toBe(
            "github (connected account) — host guard on, its connector's hosts: goes unasked only to api.github.com, github.com, anywhere else asks a person\n",
        );
        const open = await run(server.port, "secrets", ["hosts", "STRIPE_KEY"]);
        expect(open.stdout).toBe("STRIPE_KEY — host guard off: never asks where it goes\n");
    });

    it("secrets hosts add turns a guard on with the hosts given, at the route the contract declares, a pasted URL read as its host", async () => {
        server.answer = hostsDaemon([]);
        const result = await run(server.port, "secrets", ["hosts", "STRIPE_KEY", "add", "https://API.Stripe.com/v1/charges", "files.stripe.com"]);
        expect(result).toMatchObject({
            code: 0,
            stdout: "STRIPE_KEY — host guard on: goes unasked only to api.stripe.com, files.stripe.com, anywhere else asks a person.\n",
        });
        expect(server.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
            declared(["secrets", "hosts"], undefined),
            declared(["secrets", "setHosts"], { subject: "STRIPE_KEY", guard: true, hosts: [] }),
        ]);
        expect(SecretHostGuardSetSchema.parse(server.seen[1]?.body)).toEqual({
            subject: "STRIPE_KEY",
            guard: true,
            hosts: ["api.stripe.com", "files.stripe.com"],
            conversationId: "conv-cli",
        });
    });

    it("secrets hosts add to a guard that is on sends the whole wider list, and names who approved it", async () => {
        server.answer = hostsDaemon([GITHUB], "owner@corp.com");
        const result = await run(server.port, "secrets", ["hosts", "GITHUB_TOKEN", "add", "uploads.github.com"]);
        expect(result.stdout).toBe(
            "GITHUB_TOKEN — host guard on: goes unasked only to api.github.com, uploads.github.com, anywhere else asks a person (approved by owner@corp.com).\n",
        );
        expect(SecretHostGuardSetSchema.parse(server.seen[1]?.body).hosts).toEqual(["api.github.com", "uploads.github.com"]);
    });

    it("secrets hosts off and on turn a connector's guard off and back on with its hosts, through a vault name", async () => {
        server.answer = hostsDaemon([CONNECTOR], "owner@corp.com");
        const off = await run(server.port, "secrets", ["hosts", "github/token", "off"]);
        expect(off.stdout).toBe(
            "github/token — host guard off: never asks where it goes (keeps api.github.com, github.com for when it is turned back on) (approved by owner@corp.com).\n",
        );
        expect(server.seen[1]?.path).toBe("/secrets/hosts/github");
        expect(SecretHostGuardSetSchema.parse(server.seen[1]?.body)).toEqual({
            subject: "github",
            kind: "capability",
            guard: false,
            hosts: ["api.github.com", "github.com"],
            conversationId: "conv-cli",
        });
        server.answer = hostsDaemon([{ ...CONNECTOR, guard: false, source: "owner" }]);
        const on = await run(server.port, "secrets", ["hosts", "github", "on"]);
        expect(on.stdout).toBe("github — host guard on: goes unasked only to api.github.com, github.com, anywhere else asks a person.\n");
    });

    it("secrets hosts remove down to none leaves the guard on, where every use asks", async () => {
        server.answer = hostsDaemon([GITHUB]);
        const result = await run(server.port, "secrets", ["hosts", "GITHUB_TOKEN", "remove", "api.github.com"]);
        expect(result.stdout).toBe("GITHUB_TOKEN — host guard on: every use asks a person.\n");
        expect(SecretHostGuardSetSchema.parse(server.seen[1]?.body)).toMatchObject({ guard: true, hosts: [] });
    });

    it("secrets hosts remove refuses a host the guard does not hold, without asking the daemon to change anything", async () => {
        server.answer = hostsDaemon([GITHUB]);
        const result = await run(server.port, "secrets", ["hosts", "GITHUB_TOKEN", "remove", "evil.example"]);
        expect(result).toMatchObject({ code: 2, stderr: "", stdout: "secrets: evil.example is not on GITHUB_TOKEN's guard (api.github.com)\n" });
        expect(server.seen.map((seen) => seen.method)).toEqual(["GET"]);
    });

    it("secrets hosts hands back the daemon's refusal of a loosening, and exits 2", async () => {
        server.answer = (seen) =>
            seen.method === "GET"
                ? hostsDaemon([GITHUB])(seen)
                : { status: 403, body: { message: "The owner kept GITHUB_TOKEN's host guard on: nothing changed." } };
        const result = await run(server.port, "secrets", ["hosts", "GITHUB_TOKEN", "off"]);
        expect(result).toMatchObject({ code: 2, stderr: "", stdout: "secrets: The owner kept GITHUB_TOKEN's host guard on: nothing changed.\n" });
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

    it("needs done closes one as met with what the agent saw, at the route the contract declares, and asks for --how", async () => {
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["needs", "done"], { id: "need-a1b2c" })
                ? { status: 200, body: { ...OPEN_NEED, status: "met", byAgent: true } }
                : { status: 404, body: { message: `nothing at ${seen.method} ${seen.path}` } };
        const missing = await run(server.port, "needs", ["done", "need-a1b2c"]);
        expect(missing.code).toBe(2);
        expect(server.seen).toEqual([]);
        const done = await run(server.port, "needs", ["done", "need-a1b2c", "--how", "the purge answered 200"]);
        expect(done).toMatchObject({ code: 0, stdout: "need-a1b2c is met: The OPENAI_API_KEY secret.\n" });
        expect(server.seen.at(-1)?.body).toEqual({ how: "the purge answered 200" });
    });

    it("a typo exits 2 on stdout without asking for the wrong thing", async () => {
        const result = await run(server.port, "capabilities", ["request", "github", "--targte", "github.com"]);
        expect(result).toEqual({ code: 2, stdout: "capabilities: unknown option --targte\n", stderr: "" });
        expect(server.seen).toEqual([]);
    });

    it("unknown subcommands exit 2 with help on stdout", async () => {
        for (const command of ["capabilities", "secrets", "environment", "grants", "needs", "instructions"]) {
            const result = await run(server.port, command, ["typo"]);
            expect(result.code).toBe(2);
            expect(result.stdout).toContain(command);
            expect(result.stderr).toBe("");
        }
    });

    it("an unreachable daemon exits 2 with the transport error on stdout", async () => {
        const stopped = await daemon();
        await stopped.close();
        const result = await run(stopped.port, "capabilities", ["request", "github"]);
        expect(result.code).toBe(2);
        expect(result.stdout).toContain("ECONNREFUSED");
        expect(result.stderr).toBe("");
    });

    it("an HTTP failure exits 2 with the daemon's message on stdout", async () => {
        server.answer = () => ({ status: 503, body: { message: "daemon restarting" } });
        expect(await run(server.port, "capabilities", ["request", "github"])).toEqual({
            code: 2, stdout: "capabilities: daemon restarting\n", stderr: "",
        });
    });

    it("an unreadable verdict exits 2 rather than claiming a refusal", async () => {
        server.answer = () => ({ status: 200, body: { state: "unknown", message: "bad verdict" } });
        expect(await run(server.port, "capabilities", ["request", "github"])).toEqual({
            code: 2, stdout: "capabilities: unreadable answer from the daemon: expected a need verdict and message\n", stderr: "",
        });
    });
});

// The catalogue as a sandbox serves it, its watch kinds the connectors extension's (2026-11-26): what `--watch` is checked
// against before anything is asked, and what a listing names a source by.
const CATALOG = { sources: [], templates: [], watchKinds: BUILT_IN_WATCH_KINDS };
const withKinds =
    (inner: Daemon["answer"]): Daemon["answer"] =>
    (seen) =>
        `${seen.method} ${seen.path}` === declared(["automations", "catalog"], undefined) ? { status: 200, body: CATALOG } : inner(seen);

describe("the automations command speaks the automations and needs contracts", () => {
    let server: Daemon;
    // What the command asked beyond reading the catalogue.
    const asked = () => server.seen.filter((seen) => seen.method !== "GET");
    beforeAll(async () => {
        server = await daemon();
    });
    afterAll(async () => {
        await server.close();
    });
    beforeEach(() => {
        server.seen.length = 0;
    });

    it("propose sends one automation ask: the source, a schedule off the hour, this conversation as its target", async () => {
        server.answer = withKinds(raised({ state: "open", message: "Asked a person: Run an automation unattended: Bun 1.4.3 is published.", need: OPEN_NEED }));
        const result = await run(server.port, "automations", [
            "propose",
            "bun-1-4-3",
            "--watch",
            "npm",
            "--with",
            "package=bun",
            "--with",
            "range=>=1.4.3",
            "--until",
            "first-fire",
            "--note",
            "Bun 1.4.3 is published",
            "--prompt",
            "Carry out the bun check migration plan.",
            "--why",
            "bun check ships in 1.4.3",
        ]);
        expect(result.code).toBe(3);
        const body = NeedRaiseSchema.parse(asked()[0]?.body);
        expect(body.why).toBe("bun check ships in 1.4.3");
        const ask = body.ask;
        if (ask.kind !== "automation") {
            throw new Error(`expected an automation ask, got ${ask.kind}`);
        }
        expect(ask.automation).toMatchObject({
            id: "bun-1-4-3",
            enabled: true,
            source: { kind: "npm", package: "bun", range: ">=1.4.3" },
            until: "first-fire",
            target: { kind: "conversation", conversationId: "here" },
            note: "Bun 1.4.3 is published",
            prompt: "Carry out the bun check migration plan.",
        });
        // Every 6 hours by default, on a minute of its own rather than :00.
        expect(ask.automation.trigger).toMatchObject({ kind: "schedule" });
        expect(ask.automation.trigger.kind === "schedule" ? ask.automation.trigger.cron : "").toMatch(/^\d{1,2} \*\/6 \* \* \*$/);
        expect(ask.automation.models).toBeUndefined();
    });

    it("a kind's parameters are its declared fields, a switch named alone, and a new agent needs a model", async () => {
        server.answer = withKinds(raised({ state: "open", message: "Asked.", need: OPEN_NEED }));
        await run(server.port, "automations", [
            "propose",
            "bun-canary",
            "--watch",
            "npm",
            "--with",
            "package=bun",
            "--with",
            "tag=canary",
            "--fire-on",
            "change",
            "--target",
            "notify",
            "--prompt",
            "Say so.",
        ]);
        await run(server.port, "automations", [
            "propose",
            "bun-releases",
            "--watch",
            "github-release",
            "--with",
            "repo=oven-sh/bun",
            "--with",
            "prereleases",
            "--every",
            "1d",
            "--target",
            "new",
            "--model",
            "claude/claude-sonnet-4-6:low",
            "--prompt",
            "Summarise it.",
        ]);
        const asks = asked().map((seen) => NeedRaiseSchema.parse(seen.body).ask);
        expect(asks.map((ask) => (ask.kind === "automation" ? ask.automation.source : undefined))).toEqual([
            { kind: "npm", package: "bun", tag: "canary" },
            { kind: "github-release", repo: "oven-sh/bun", prereleases: true },
        ]);
        expect(asks.map((ask) => (ask.kind === "automation" ? ask.automation.target : undefined))).toEqual([{ kind: "notify" }, { kind: "agent" }]);
        expect(asks[1]?.kind === "automation" ? asks[1].automation.models : undefined).toEqual([
            { provider: "claude", model: "claude-sonnet-4-6", effort: "low" },
        ]);

        const modelless = await run(server.port, "automations", ["propose", "x", "--watch", "github-release", "--with", "repo=a/b", "--target", "new", "--prompt", "p"]);
        expect(modelless.code).toBe(2);
        expect(modelless.stdout).toContain("needs at least one --model");
    });

    it("a kind's fields are held before anything is asked, and the retired spellings say what replaced them", async () => {
        server.answer = withKinds(raised({ state: "open", message: "Asked.", need: OPEN_NEED }));
        const propose = (...source: string[]) => run(server.port, "automations", ["propose", "x", ...source, "--prompt", "p"]);
        expect((await propose("--watch", "github-release", "--with", "repo=bun")).stdout).toContain("Repository must look like owner/name");
        expect((await propose("--watch", "npm", "--with", "version=1")).stdout).toContain("a npm watch has no version: it takes package, range, tag");
        expect((await propose("--watch", "npm")).stdout).toContain("a npm watch needs --with package=<package>");
        expect((await propose("--watch", "pypi", "--with", "package=x")).stdout).toContain("no extension here checks pypi watches: the kinds here are npm, github-release");
        expect((await propose("--npm", "bun@>=1.4.3")).stdout).toContain("--npm is now --watch npm --with package=<name>");
        expect((await propose("--github", "oven-sh/bun")).stdout).toContain("--github is now --watch github-release --with repo=<owner/name>");
        expect(asked()).toEqual([]);
    });

    it("kinds lists every watch kind from the catalogue, with what --watch and --with take", async () => {
        server.answer = withKinds(() => ({ status: 404, body: {} }));
        const result = await run(server.port, "automations", ["kinds"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("github-release — GitHub release, from intentic.connectors");
        expect(result.stdout).toContain("--with repo=<oven-sh/bun>  Repository (required)");
        expect(result.stdout).toContain("--with prereleases  Prereleases too");
        expect(result.stdout).toContain("--watch npm");
    });

    it("propose --on asks for a listener that starts a new agent, its senders wearing the role it names", async () => {
        server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
        const result = await run(server.port, "automations", [
            "propose",
            "gmail-from-boss",
            "--on",
            "google",
            "--event",
            "mail",
            "--from",
            "boss@example.com",
            "--from",
            "deputy@example.com",
            "--as",
            "mail-reader",
            "--model",
            "claude/claude-opus-5-5",
            "--prompt",
            "Act on the mail.",
            "--why",
            "react to the boss's mail",
        ]);
        expect(result.code).toBe(3);
        const ask = NeedRaiseSchema.parse(server.seen[0]?.body).ask;
        if (ask.kind !== "automation") {
            throw new Error(`expected an automation ask, got ${ask.kind}`);
        }
        expect(ask.automation).toEqual({
            id: "gmail-from-boss",
            enabled: true,
            trigger: { kind: "listener", provider: "google", eventType: "mail" },
            target: { kind: "agent" },
            models: [{ provider: "claude", model: "claude-opus-5-5" }],
            actsAs: "mail-reader",
            senders: { rules: [{ ids: ["boss@example.com", "deputy@example.com"], actsAs: "mail-reader" }], others: "ignore" },
            prompt: "Act on the mail.",
        });
    });

    it("propose --on refuses what a listener cannot be, and a listener's filters without --on", async () => {
        const modelless = await run(server.port, "automations", ["propose", "x", "--on", "google", "--prompt", "p"]);
        expect(modelless).toMatchObject({ code: 2 });
        expect(modelless.stdout).toContain("needs at least one --model");
        const scheduled = await run(server.port, "automations", ["propose", "x", "--on", "google", "--every", "1h", "--model", "a/b", "--prompt", "p"]);
        expect(scheduled.stdout).toContain("takes no --watch, --url, --every or --cron");
        const continuing = await run(server.port, "automations", ["propose", "x", "--on", "google", "--target", "here", "--model", "a/b", "--prompt", "p"]);
        expect(continuing.stdout).toContain("can only start a new agent");
        server.answer = withKinds(() => ({ status: 404, body: {} }));
        const stray = await run(server.port, "automations", ["propose", "x", "--watch", "npm", "--with", "package=bun", "--from", "a@b.c", "--prompt", "p"]);
        expect(stray.stdout).toContain("--from narrows a listener");
        expect(asked()).toEqual([]);
    });

    it("sources lists each listener from the catalogue the contract declares, with the flags that narrow it", async () => {
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["automations", "catalog"], undefined)
                ? {
                      status: 200,
                      body: {
                          sources: [
                              {
                                  provider: "google",
                                  label: "Google Workspace",
                                  events: [{ value: "mail", label: "New mail" }],
                                  channel: { label: "Gmail label", placeholder: "every inbox" },
                                  sender: { label: "Sender address", placeholder: "name@example.com" },
                                  mentionLabel: "Only mail addressed to you",
                                  requires: ["google"],
                                  enabled: true,
                              },
                          ],
                          templates: [],
                      },
                  }
                : { status: 404, body: { message: `nothing at ${seen.path}` } };
        const result = await run(server.port, "automations", ["sources"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("google — Google Workspace · needs a connected google");
        expect(result.stdout).toContain("--event mail (New mail)");
        expect(result.stdout).toContain("--from Sender address");
        expect(result.stdout).toContain("--mentioned Only mail addressed to you");
    });

    it("check runs one source through the route the contract declares and exits by whether it passes", async () => {
        server.answer = withKinds((seen) =>
            `${seen.method} ${seen.path}` === declared(["automations", "check"], seen.body)
                ? { status: 200, body: { pass: false, saw: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)" } }
                : { status: 404, body: { message: `nothing at ${seen.path}` } });
        const result = await run(server.port, "automations", ["check", "--watch", "npm", "--with", "package=bun", "--with", "range=>=1.4.3"]);
        expect(result).toMatchObject({ code: 1, stdout: "does not pass: no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)\n" });
        expect(asked()[0]?.body).toEqual({ source: { kind: "npm", package: "bun", range: ">=1.4.3" } });
    });

    it("the listing says what each automation checks, in its kind's own words, where it goes and what it saw last", async () => {
        server.answer = withKinds((seen) =>
            seen.method === "GET" && seen.path === "/automations"
                ? {
                      status: 200,
                      body: {
                          automations: [
                              {
                                  id: "bun-1-4-3",
                                  enabled: true,
                                  trigger: { kind: "schedule", cron: "17 */6 * * *" },
                                  source: { kind: "npm", package: "bun", range: ">=1.4.3" },
                                  until: "first-fire",
                                  target: { kind: "conversation", conversationId: "rapid-ridge" },
                                  note: "Bun 1.4.3 is published",
                                  prompt: "Carry on.",
                                  runs: [],
                                  watch: { armedAt: Date.now() - 3_600_000, checkedAt: Date.now() - 60_000, waiting: "no published version yet" },
                              },
                          ],
                      },
                  }
                : { status: 404, body: {} });
        const result = await run(server.port, "automations", []);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("bun-1-4-3 [on] cron 17 */6 * * *");
        expect(result.stdout).toContain("checks npm bun@>=1.4.3 → continues rapid-ridge");
        expect(result.stdout).toContain("checked 1m ago · waiting: no published version yet");
    });
});
