import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintSandboxPass, type PassScope, ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { S2sThreadSchema, S2sThreadsListSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { testConfig } from "../env.config.testing.js";
import { clientFor, proven } from "../harness/route-client.testing.js";
import { memoryMembersStore } from "../harness/route-stores.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";
import { accountOutboxOf } from "./account-outbox.js";
import { legacyMessageIdOf } from "./messages/drop-threads.js";
import { turnProof } from "../seams/workload-stamp.js";
import { filePairingsStore } from "./pairings-store.js";
import { routeSecretsOf } from "./route-secrets.js";

// Routing as a person, both halves over HTTP: a sending sandbox's daemon (its `sandboxes send` door and its `--on`
// relay) and a receiving one's (the drop door, the Messages tab's threads, the read doors), with the platform's directory
// faked on a local port and the receiver's address answered by its own app. Neither holds a contact for the other, so
// the drop goes the old way. What matters: only a person on the receiving roster at the drop floor and paired with the
// sender gets anything in; a drop lands as a message in its sender's thread and is taken from there; `wake` reaches only
// that person's own conversation; a target that is down gets the drop later; a read sees only what the person may read
// there, a private conversation never.

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const RECEIVER_TOKEN = "connect-token-of-the-receiver";
const SENDER_TOKEN = "connect-token-of-the-sender";
const RECEIVER = sandboxIdFromToken(RECEIVER_TOKEN) ?? "";
const SENDER = sandboxIdFromToken(SENDER_TOKEN) ?? "";
const HOME = "https://home.sbx.test";
const AGENT = { "x-intentic-agent": "agent-secret" };
const ADA = "ada@acme.test";

const AnswerSchema = z.looseObject({});
const json = async (response: Response | Promise<Response>) => {
    const answered = await response;
    return { status: answered.status, body: AnswerSchema.parse(await answered.json()) };
};

// The receiving sandbox: Ada is a collaborator who runs agents, Vic a viewer, Max a maintainer; its editor is Ada's.
const receiving = () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "receiver-history-"));
    const svc: Services = services({
        config: { ...testConfig, connectToken: RECEIVER_TOKEN, historyRoot },
        auth: { authorize: async () => proven(ADA, "collaborator") },
        platformIdentityKey: { current: () => publicKey, learn: () => {}, settled: async () => publicKey },
        members: memoryMembersStore([
            { email: ADA, tier: "collaborator" },
            { email: "vic@acme.test", tier: "viewer" },
            { email: "max@acme.test", tier: "maintainer" },
        ]),
        ownerEmail: async () => "owner@acme.test",
        // Each author chooses, so a conversation opened private is born sealed to its author.
        sealHouse: unstubbed<Services["sealHouse"]>("sealHouse", { read: async () => ({ mode: "chooses" as const, defaults: {} }) }),
        turnCheckpoints: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
        async *agent() {
            yield { kind: "session", sessionId: "sess-home" };
            yield { kind: "done" };
        },
        sessions: {
            list: async () => [],
            read: async () => [{ role: "user" as const, text: "plan the release" }],
            readTail: async () => [],
            search: async () => [],
            exists: async () => true,
        },
    });
    const steered: { conversationId: string; text: string; outside?: string | undefined }[] = [];
    const live = new Set<string>();
    // A turn is running only where a suite says one is: steer reaches it, and nothing else.
    // Takes land in a workspace of the suite's own, written for real.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "receiver-workspace-"));
    const withSteer: Services = {
        ...svc,
        workspace: { ...svc.workspace, root: workspaceRoot },
        files: {
            ...svc.files,
            write: async (path, content) => {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, content);
            },
        },
        turns: {
            ...svc.turns,
            steer: async (conversationId, steer) => {
                if (!live.has(conversationId)) {
                    return false;
                }
                steered.push({ conversationId, text: steer.text, outside: steer.outside });
                return true;
            },
        },
    };
    const app = createApp(withSteer);
    return { app, services: withSteer, historyRoot, steered, live, pairings: filePairingsStore(historyRoot) };
};

// The sending sandbox, whose owner is the person every send goes as (a conversation acting for nobody acts for its owner).
const sending = (person: { email: string }) => {
    const historyRoot = mkdtempSync(join(tmpdir(), "sender-history-"));
    const agentAuthDir = mkdtempSync(join(tmpdir(), "sender-auth-"));
    // The cards a send raised, by conversation: a need raised is all the sending side does about a missing pairing.
    const raised: { conversationId: string; kind: string }[] = [];
    const base = services({
        config: { ...testConfig, connectToken: SENDER_TOKEN, historyRoot, agentAuthDir, platform: { ...testConfig.platform, url: platformUrl } },
        ownerEmail: async () => person.email,
    });
    const svc: Services = {
        ...base,
        needs: {
            ...base.needs,
            observe: async (conversationId, subject, title) => {
                raised.push({ conversationId, kind: subject.kind });
                return unstubbed<Need>("need", { id: `need-${raised.length}`, conversationId, subject, title });
            },
        },
    };
    return { app: createApp(svc), services: svc, historyRoot, raised };
};

// The platform's directory: a pass for whichever scope and person is asked, to the receiver.
let platform: Server | undefined;
let platformUrl = "";
const passFor = (scope: PassScope, person: string): string =>
    mintSandboxPass(privateKey, { from: SENDER, fromName: "ops", to: RECEIVER, scope, person, issuedAtMs: Date.now() });

beforeAll(async () => {
    platform = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
        });
        request.on("end", () => {
            // Anything else the sender's daemon asks the platform (a heard run-out, an announce) is a route it does not serve.
            const asked = z
                .object({ scope: z.enum(["report", "drop", "read", "task"]), person: z.string() })
                .safeParse(request.url === "/projects/route" ? JSON.parse(raw) : undefined).data;
            if (asked === undefined) {
                response.writeHead(404).end();
                return;
            }
            const answer = {
                scope: asked.scope,
                sandboxId: RECEIVER,
                name: "home",
                address: HOME,
                pass: passFor(asked.scope, asked.person),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
            };
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        });
    });
    await new Promise<void>((resolve) => platform?.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
});
afterAll(() => platform?.close());

// The receiver's address answered by its app; `down` makes it answer nothing at all, as an asleep sandbox does.
const realFetch = globalThis.fetch;
let receiver: ReturnType<typeof receiving> | undefined;
let down = false;
beforeEach(() => {
    down = false;
    const relay = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== HOME) {
            return realFetch(input, init);
        }
        if (down || receiver === undefined) {
            throw new TypeError("fetch failed");
        }
        return receiver.app.request(`http://sandbox.test${url.pathname}${url.search}`, {
            method: init?.method ?? "GET",
            headers: init?.headers ?? {},
            body: init?.body ?? null,
        });
    };
    jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(relay, { preconnect: realFetch.preconnect }));
});
afterEach(() => {
    jest.restoreAllMocks();
    receiver = undefined;
});

// Pairs `person` from the sender into the receiver: the hash there, the secret here.
const pair = async (from: ReturnType<typeof sending>, to: ReturnType<typeof receiving>, person: string): Promise<void> => {
    const { secret } = await to.pairings.mint({ from: SENDER, fromName: "ops", person }, Date.now());
    await routeSecretsOf(from.services).put(RECEIVER, person, secret, Date.now());
};

// `sandboxes send` as a proven turn of `conversationId` on the sender.
const send = (from: ReturnType<typeof sending>, body: object, conversationId = "sender-talk") =>
    json(
        from.app.request("http://sandbox.test/account/drops", {
            method: "POST",
            headers: {
                ...AGENT,
                "x-intentic-conversation": conversationId,
                "x-intentic-turn-proof": turnProof(conversationId),
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        }),
    );

const file = (name: string, text: string) => ({ name, data: Buffer.from(text).toString("base64") });

// The receiver's threads, as whoever the headers make the asker (Ada signed in, with none).
const threadsOf = async (to: ReturnType<typeof receiving>, headers: Record<string, string> = {}) =>
    S2sThreadsListSchema.parse(await (await to.app.request("http://sandbox.test/s2s/threads", { headers })).json()).threads;
const threadOf = async (to: ReturnType<typeof receiving>, id: string) => S2sThreadSchema.parse(await (await to.app.request(`http://sandbox.test/s2s/threads/${id}`)).json());

describe("a drop", () => {
    test("is refused to a person below the drop floor there, a viewer", async () => {
        receiver = receiving();
        const from = sending({ email: "vic@acme.test" });
        await pair(from, receiver, "vic@acme.test");
        const answer = await send(from, { sandbox: "home", note: "the logs you asked for" });
        expect(answer).toMatchObject({ status: 200, body: { state: "refused", reason: expect.stringContaining("may not drop here") } });
        expect(await receiver.services.s2s.threads.list()).toEqual([]);
    });

    test("without the person's pairing sends nothing and raises their card in the sending conversation", async () => {
        receiver = receiving();
        const from = sending({ email: ADA });
        const answer = await send(from, { sandbox: "home", note: "the logs you asked for", files: [file("app.log", "boom")] });
        expect(answer).toMatchObject({
            status: 200,
            body: { state: "asked", needId: expect.any(String), reason: expect.stringContaining("a card asks them now") },
        });
        expect(from.raised).toEqual([{ conversationId: "sender-talk", kind: "route" }]);
        expect(await receiver.services.s2s.threads.list()).toEqual([]);
        // Nothing staged was left behind.
        expect(readdirSync(from.historyRoot)).not.toContain("account-outbox-staged");
    });

    test("is delivered as a message in its sender's thread, shown to its person and never to a shell that names no turn, taken, and deleted", async () => {
        receiver = receiving();
        const from = sending({ email: ADA });
        await pair(from, receiver, ADA);
        const answer = await send(from, {
            sandbox: "home",
            note: "the logs you asked for",
            files: [file("app.log", "boom"), file("notes.md", "# why")],
        });
        expect(answer).toMatchObject({ status: 200, body: { state: "delivered", to: "home" } });
        const message = legacyMessageIdOf(String(answer.body["id"]));

        // Ada's editor lists the sender's thread, hers. A shell naming no conversation is shown none: an agent can unset
        // its own variables.
        const [thread, ...more] = await threadsOf(receiver);
        expect(more).toEqual([]);
        if (thread === undefined) {
            throw new Error("no thread for the drop");
        }
        expect(thread).toMatchObject({ contactName: "ops", scope: { kind: "person", person: ADA }, unread: 1, messages: 1, last: { direction: "in", preview: "the logs you asked for" } });
        const { id } = thread;
        expect((await threadOf(receiver, id)).messages).toEqual([
            {
                id: message,
                thread: id,
                contact: thread.contact,
                direction: "in",
                kind: "message",
                text: "the logs you asked for",
                attachments: [
                    { name: "app.log", size: 4 },
                    { name: "notes.md", size: 5 },
                ],
                as: ADA,
                sentAt: expect.any(Number),
                receivedAt: expect.any(Number),
                read: false,
            },
        ]);
        expect(await threadsOf(receiver, AGENT)).toEqual([]);
        // A turn acting for nobody on it (the owner here) is shown none of it.
        const turn = { ...AGENT, "x-intentic-conversation": "owner-talk", "x-intentic-turn-proof": turnProof("owner-talk") };
        expect(await threadsOf(receiver, turn)).toEqual([]);
        expect((await receiver.app.request(`http://sandbox.test/s2s/messages/${message}/files/app.log`, { headers: turn })).status).toBe(404);

        // The files come back whole to whoever is shown the thread (here Ada, signed in), and Take writes them into a
        // folder of the workspace.
        expect(await (await receiver.app.request(`http://sandbox.test/s2s/messages/${message}/files/app.log`)).text()).toBe("boom");
        const take = () =>
            receiver?.app.request(`http://sandbox.test/s2s/messages/${message}/take`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ dest: "from-ops" }),
            }) ?? Promise.reject(new Error("no receiver"));
        expect(await json(take())).toMatchObject({ status: 200, body: { files: ["app.log", "notes.md"] } });
        expect(readFileSync(join(receiver.services.workspace.root, "from-ops", "app.log"), "utf8")).toBe("boom");
        // A second take onto the same files is refused rather than overwriting them.
        expect((await take()).status).toBe(409);
        // Never out of the workspace.
        const outside = await receiver.app.request(`http://sandbox.test/s2s/messages/${message}/take`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dest: "../elsewhere" }),
        });
        expect(outside.status).toBe(400);

        expect((await receiver.app.request(`http://sandbox.test/s2s/threads/${id}`, { method: "DELETE" })).status).toBe(200);
        expect(await threadsOf(receiver)).toEqual([]);
        // It is on the history volume, gone with the delete, and never in the old inbox; the sender kept nothing staged.
        expect(readdirSync(join(receiver.historyRoot, "s2s-files"))).toEqual([]);
        expect(readdirSync(receiver.historyRoot)).not.toContain("account-inbox");
        expect(readdirSync(join(from.historyRoot, "account-outbox-staged"))).toEqual([]);
    });

    test("whose pairing the person took back over there is refused, and the sender forgets the secret", async () => {
        receiver = receiving();
        const from = sending({ email: ADA });
        await pair(from, receiver, ADA);
        await receiver.pairings.revoke(SENDER, ADA);
        const answer = await send(from, { sandbox: "home", note: "hello" });
        expect(answer.body).toMatchObject({ state: "refused" });
        expect(await routeSecretsOf(from.services).secretFor(RECEIVER, ADA)).toBeUndefined();
    });

    test("with wake reaches only that person's own conversation, and only while a turn of it runs", async () => {
        receiver = receiving();
        await runAgentTurn(clientFor(receiver.app), { prompt: "plan the release", conversationId: "ada-talk", isolated: true });
        const from = sending({ email: ADA });
        await pair(from, receiver, ADA);

        // Someone else's conversation, or none at all, is refused before anything lands.
        const elsewhere = await send(from, { sandbox: "home", note: "for you", wake: "not-hers" });
        expect(elsewhere.body).toMatchObject({ state: "refused", reason: expect.stringContaining("has no conversation not-hers of their own") });

        // Hers, with no turn running: kept in her thread, nothing started.
        const idle = await send(from, { sandbox: "home", note: "for later", wake: "ada-talk" });
        expect(idle.body).toMatchObject({ state: "delivered" });
        expect(receiver.steered).toEqual([]);

        // Hers, while a turn of it runs: said into it as outside content.
        receiver.live.add("ada-talk");
        const live = await send(from, { sandbox: "home", note: "the numbers are in", wake: "ada-talk" });
        expect(live.body).toMatchObject({ state: "delivered" });
        // Read before the match below, which leaves its matchers in the array it compared.
        const saidText = receiver.steered[0]?.text ?? "";
        expect(receiver.steered).toMatchObject([
            { conversationId: "ada-talk", text: expect.stringContaining("the numbers are in"), outside: expect.stringContaining("ops") },
        ]);
        const [thread] = await threadsOf(receiver);
        const said = (await threadOf(receiver, thread?.id ?? "")).messages;
        expect(said.map((message) => message.text)).toEqual(["for later", "the numbers are in"]);
        // What the woken turn reads points at where the drop waits.
        expect(saidText).toContain(`messages show ${thread?.id ?? ""}`);
    });

    test("to a sandbox that is down waits in the outbox, and lands once it is back", async () => {
        receiver = receiving();
        const from = sending({ email: ADA });
        await pair(from, receiver, ADA);
        down = true;
        const answer = await send(from, { sandbox: "home", note: "when you wake", files: [file("a.txt", "a")] });
        expect(answer.body).toMatchObject({ state: "queued", to: "home" });
        expect((await accountOutboxOf(from.services).list()).map((entry) => entry.kind)).toEqual(["drop"]);

        // Its retry comes due, and the sandbox is up again.
        const dir = join(from.historyRoot, "account-outbox");
        for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
            const entry = z.looseObject({}).parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
            writeFileSync(join(dir, name), JSON.stringify({ ...entry, nextAt: 0 }));
        }
        down = false;
        await accountOutboxOf(from.services).drain();
        expect(await accountOutboxOf(from.services).list()).toEqual([]);
        const [thread] = await threadsOf(receiver);
        expect((await threadOf(receiver, thread?.id ?? "")).messages).toMatchObject([{ text: "when you wake", attachments: [{ name: "a.txt", size: 1 }] }]);
    });
});

describe("a read as a person", () => {
    // A read pass for `person` with their pairing, straight at the receiver's door.
    const door = async (to: ReturnType<typeof receiving>, person: string, path: string, body?: object) => {
        const { secret } = await to.pairings.mint({ from: SENDER, fromName: "ops", person }, Date.now());
        const headers = { [SANDBOX_PASS_HEADER]: passFor("read", person), [ROUTE_SECRET_HEADER]: secret, "content-type": "application/json" };
        return json(
            to.app.request(`http://sandbox.test${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }),
        );
    };

    const withTalks = async (): Promise<ReturnType<typeof receiving>> => {
        const to = receiving();
        await runAgentTurn(clientFor(to.app), { prompt: "plan the release", conversationId: "open-talk", isolated: true });
        await runAgentTurn(clientFor(to.app), { prompt: "my review notes", conversationId: "sealed-talk", isolated: true, private: true });
        return to;
    };

    test("never shows a private conversation to someone who is not its reader, a maintainer included", async () => {
        const to = await withTalks();
        const roster = await door(to, "max@acme.test", "/account/read/agents");
        expect(roster).toMatchObject({ status: 200, body: { agents: [{ id: "open-talk" }] } });
        expect(roster.body["agents"]).toHaveLength(1);
        expect((await door(to, "max@acme.test", "/account/read/agents/sealed-talk?transcript=1")).status).toBe(404);
        expect((await door(to, "max@acme.test", "/account/read/agents/sealed-talk/bundle")).status).toBe(404);
        expect(await door(to, "max@acme.test", "/account/read/agents/open-talk?transcript=1")).toMatchObject({
            status: 200,
            body: { agent: { id: "open-talk" } },
        });
        // Its own reader reads it.
        expect((await door(to, ADA, "/account/read/agents")).body["agents"]).toHaveLength(2);
    });

    test("refuses diagnostics below maintainer, and answers them for one", async () => {
        const to = await withTalks();
        expect(await door(to, ADA, "/account/read/diagnostics", { query: "restarts" })).toMatchObject({ status: 403, body: { code: "floor" } });
        expect(await door(to, "max@acme.test", "/account/read/diagnostics", { query: "restarts" })).toMatchObject({
            status: 200,
            body: { text: expect.any(String) },
        });
    });

    test("is refused without the pass's person paired", async () => {
        const to = await withTalks();
        const unpaired = await json(
            to.app.request("http://sandbox.test/account/read/agents", { headers: { [SANDBOX_PASS_HEADER]: passFor("read", ADA) } }),
        );
        expect(unpaired).toMatchObject({ status: 403, body: { code: "pairing" } });
    });

    test("goes from `agents ls --on <sandbox>` when no link has that name, as the asking turn's person", async () => {
        receiver = await withTalks();
        const from = sending({ email: "max@acme.test" });
        await pair(from, receiver, "max@acme.test");
        const turn = { ...AGENT, "x-intentic-conversation": "sender-talk", "x-intentic-turn-proof": turnProof("sender-talk") };
        const roster = await json(from.app.request("http://sandbox.test/fleet?on=home", { headers: turn }));
        expect(roster).toMatchObject({ status: 200, body: { agents: [{ id: "open-talk" }] } });
        expect(roster.body["agents"]).toHaveLength(1);
        const diagnostics = await json(
            from.app.request("http://sandbox.test/diagnostics", {
                method: "POST",
                headers: { ...turn, "content-type": "application/json" },
                body: JSON.stringify({ query: "restarts", on: "home" }),
            }),
        );
        expect(diagnostics).toMatchObject({ status: 200, body: { text: expect.any(String) } });
    });
});
