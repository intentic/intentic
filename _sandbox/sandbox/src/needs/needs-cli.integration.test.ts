import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import {
    CapabilityConnectableSchema,
    type CredentialGate,
    CredentialGatesSchema,
    type NeedRaised,
    NeedRaiseSchema,
    NeedsListSchema,
    NeedSchema,
    SecretGeneratedSchema,
    SecretGenerateSchema,
    type SecretHostGuard,
    SecretHostGuardsSchema,
    SecretHostGuardSetResultSchema,
    SecretHostGuardSetSchema,
    sandboxRequestFor,
} from "@intentic/sandbox-contract";

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

    it("secrets generate hands back the daemon's sentence for a name something already holds, and exits 2", async () => {
        server.answer = () => ({ status: 409, body: { message: '"SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.' } });
        const taken = await run(server.port, "secrets", ["generate", "SESSION_SECRET"]);
        expect(taken).toMatchObject({ code: 2, stderr: "", stdout: 'secrets: "SESSION_SECRET" is already stored: use it as it is, or pick a name nothing here holds.\n' });
        expect(server.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([declared(["secrets", "generate"], { key: "SESSION_SECRET" })]);
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

    it("a typo exits 2 on stdout without asking for the wrong thing", async () => {
        const result = await run(server.port, "capabilities", ["request", "github", "--targte", "github.com"]);
        expect(result).toEqual({ code: 2, stdout: "capabilities: unknown option --targte\n", stderr: "" });
        expect(server.seen).toEqual([]);
    });

    it("unknown subcommands exit 2 with help on stdout", async () => {
        for (const command of ["capabilities", "secrets", "environment", "grants", "needs"]) {
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

describe("the automations command speaks the automations and needs contracts", () => {
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

    it("propose sends one automation ask: the source, a schedule off the hour, this conversation as its target", async () => {
        server.answer = raised({ state: "open", message: "Asked a person: Run an automation unattended: Bun 1.4.3 is published.", need: OPEN_NEED });
        const result = await run(server.port, "automations", [
            "propose",
            "bun-1-4-3",
            "--npm",
            "bun@>=1.4.3",
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
        const body = NeedRaiseSchema.parse(server.seen[0]?.body);
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

    it("a dist-tag is a tag, a GitHub source carries its repo, and a new agent needs a model", async () => {
        server.answer = raised({ state: "open", message: "Asked.", need: OPEN_NEED });
        await run(server.port, "automations", [
            "propose",
            "bun-canary",
            "--npm",
            "bun@canary",
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
            "--github",
            "oven-sh/bun",
            "--every",
            "1d",
            "--target",
            "new",
            "--model",
            "claude/claude-sonnet-4-6:low",
            "--prompt",
            "Summarise it.",
        ]);
        const asks = server.seen.map((seen) => NeedRaiseSchema.parse(seen.body).ask);
        expect(asks.map((ask) => (ask.kind === "automation" ? ask.automation.source : undefined))).toEqual([
            { kind: "npm", package: "bun", tag: "canary" },
            { kind: "github-release", repo: "oven-sh/bun" },
        ]);
        expect(asks.map((ask) => (ask.kind === "automation" ? ask.automation.target : undefined))).toEqual([{ kind: "notify" }, { kind: "agent" }]);
        expect(asks[1]?.kind === "automation" ? asks[1].automation.models : undefined).toEqual([
            { provider: "claude", model: "claude-sonnet-4-6", effort: "low" },
        ]);

        const modelless = await run(server.port, "automations", ["propose", "x", "--github", "a/b", "--target", "new", "--prompt", "p"]);
        expect(modelless.code).toBe(2);
        expect(modelless.stdout).toContain("needs at least one --model");
    });

    it("check runs one source through the route the contract declares and exits by whether it passes", async () => {
        server.answer = (seen) =>
            `${seen.method} ${seen.path}` === declared(["automations", "check"], seen.body)
                ? { status: 200, body: { pass: false, saw: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)" } }
                : { status: 404, body: { message: `nothing at ${seen.path}` } };
        const result = await run(server.port, "automations", ["check", "--npm", "bun@>=1.4.3"]);
        expect(result).toMatchObject({ code: 1, stdout: "does not pass: no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)\n" });
        expect(server.seen[0]?.body).toEqual({ source: { kind: "npm", package: "bun", range: ">=1.4.3" } });
    });

    it("the listing says what each automation checks, where it goes and what it saw last", async () => {
        server.answer = (seen) =>
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
                : { status: 404, body: {} };
        const result = await run(server.port, "automations", []);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("bun-1-4-3 [on] cron 17 */6 * * *");
        expect(result.stdout).toContain("checks npm bun@>=1.4.3 → continues rapid-ridge");
        expect(result.stdout).toContain("checked 1m ago · waiting: no published version yet");
    });
});
