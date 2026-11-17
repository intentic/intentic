import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import type { AccountReport } from "@intentic/sandbox-contract/schemas/issues";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { mintSandboxPass, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { fileAutomationsStore } from "../automations/automations-store.js";
import { fileHeldWakesStore } from "../automations/held-wakes-store.js";
import { memoryDoorTokens } from "../auth/tokens/door-tokens.js";
import type { Services } from "../composition.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import { createDomainEvents } from "../seams/domain-events.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy } from "../seams/turn-starter.testing.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { sqliteTurnJournal } from "../store/journals/turn-journal.js";
import { ACCOUNT_REPORTS_ID, createAccountRoutes } from "./account.routes.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

// The receiving door of account-level report routing. What matters: only a pass the platform signed for THIS sandbox
// gets in, who reported is read from the pass and never from the body, and once in, the intake's own arithmetic holds
// (five sandboxes seeing one thing is one issue, and a repeat wakes nobody).

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const CONNECT_TOKEN = "connect-token-of-the-receiver";
const SELF = sandboxIdFromToken(CONNECT_TOKEN) ?? "";
const OPS = "aaaaaaaaaaaa";
const PROJECT = "github.com/acme/app";

const passFrom = (from: string, over: Partial<Parameters<typeof mintSandboxPass>[1]> = {}): string =>
    mintSandboxPass(privateKey, { from, fromName: from === OPS ? "ops" : "other", to: SELF, project: PROJECT, issuedAtMs: Date.now(), ...over });

const fakeServices = (root: string, key: string | undefined): Services =>
    unstubbed<Services>("services", {
        events: createDomainEvents(() => {}),
        conversations: memoryFleet().conversations,
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        doorTokens: memoryDoorTokens(),
        heldWakes: fileHeldWakesStore(join(root, "history")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json"), () => false),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
        members: { list: async () => [], add: async () => {}, remove: async () => {} },
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async () => ({ delivered: 0, failed: 0 }),
            notifyIfAway: async () => ({ delivered: 0, failed: 0 }),
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ admission: { issues: "allow" } }),
        }),
        config: unstubbed<Services["config"]>("config", { connectToken: CONNECT_TOKEN }),
        platformIdentityKey: unstubbed<Services["platformIdentityKey"]>("platformIdentityKey", { settled: async () => key }),
    });

const intake = (id: string): Automation => automationConfig(id, { trigger: { kind: "listener", provider: "issues" }, prompt: `fix:${id}` });

const problem = (over: Partial<AccountReport["report"]> = {}): AccountReport["report"] => ({
    kind: "detection",
    message: "GET /api/orders answered 500 for order 81231",
    ...over,
});

const setup = async (options: { automation?: Automation; key?: string | undefined } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "account-report-"));
    const services = fakeServices(root, "key" in options ? options.key : publicKey);
    if (options.automation !== undefined) {
        await services.automations.upsert(options.automation);
    }
    const issues: IssuesStore = fileIssuesStore(join(root, "issues"));
    const turns: AgentTurn[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        turns.push(input);
        yield { kind: "done" };
    };
    const routes = createAccountRoutes(drivenBy(services, wake), { issues });
    const app = new Hono().post("/account/report", routes.report);
    const post = async (pass: string | undefined, body: unknown) => {
        const headers = new Headers({ "content-type": "application/json" });
        if (pass !== undefined) {
            headers.set(SANDBOX_PASS_HEADER, pass);
        }
        const res = await app.request("/account/report", { method: "POST", headers, body: JSON.stringify(body) });
        const answer: { id?: string; error?: string } = await res.json();
        return { status: res.status, ...answer };
    };
    return { issues, turns, post };
};

const settled = async (until: () => boolean): Promise<void> => {
    for (let waited = 0; waited < 5_000 && !until(); waited += 5) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

test("a pass signed for this sandbox files the report under the intake, with the sender the pass names", async () => {
    const { issues, turns, post } = await setup({ automation: intake("bugs") });
    const answer = await post(passFrom(OPS), { report: problem(), conversationId: "brave-fox-1a2b" });
    expect(answer.status).toBe(200);
    await settled(() => turns.length === 1);
    expect(await issues.read(answer.id ?? "")).toMatchObject({
        automationId: "bugs",
        kind: "detection",
        count: 1,
        sender: { sandboxId: OPS, sandboxName: "ops", project: PROJECT, conversationId: "brave-fox-1a2b" },
    });
    expect(turns[0]?.prompt).toContain('"reportedBy"');
});

test("the same problem from several sandboxes, or folded repeats, is one issue that wakes once", async () => {
    const { issues, turns, post } = await setup({ automation: intake("bugs") });
    const first = await post(passFrom(OPS), { report: problem() });
    await settled(() => turns.length === 1);
    // Another number in the message is the same problem; another sandbox reporting it is still the same issue.
    const second = await post(passFrom("bbbbbbbbbbbb"), { report: problem({ message: "GET /api/orders answered 500 for order 99" }), times: 3 });
    expect(second.id).toBe(first.id);
    expect(await issues.read(first.id ?? "")).toMatchObject({ count: 4, sender: { sandboxId: "bbbbbbbbbbbb" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turns).toHaveLength(1);
});

test("one problem about two projects stays two issues", async () => {
    const { post } = await setup({ automation: intake("bugs") });
    const app = await post(passFrom(OPS), { report: problem() });
    const site = await post(passFrom(OPS, { project: "github.com/acme/site" }), { report: problem() });
    expect(site.id).not.toBe(app.id);
});

test("with no intake set up, the report is still recorded and wakes nobody", async () => {
    const { issues, turns, post } = await setup();
    const answer = await post(passFrom(OPS), { report: problem() });
    expect(answer.status).toBe(200);
    expect(await issues.read(answer.id ?? "")).toMatchObject({ automationId: ACCOUNT_REPORTS_ID, count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turns).toHaveLength(0);
});

test("refuses a missing pass, a pass for another sandbox, another key's pass, an expired one, and an ungroupable body", async () => {
    const { post } = await setup({ automation: intake("bugs") });
    expect((await post(undefined, { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS, { to: "cccccccccccc" }), { report: problem() })).status).toBe(401);
    const stranger = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const forged = mintSandboxPass(stranger.privateKey, { from: OPS, fromName: "ops", to: SELF, project: PROJECT, issuedAtMs: Date.now() });
    expect((await post(forged, { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS, { issuedAtMs: Date.now() - 11 * 60_000 }), { report: problem() })).status).toBe(401);
    expect((await post(passFrom(OPS), { report: { kind: "report", message: "ungrouped words" } })).status).toBe(400);
});

test("asks the sender to retry while this sandbox has not learned the platform's key", async () => {
    const { post } = await setup({ key: undefined });
    expect((await post(passFrom(OPS), { report: problem() })).status).toBe(503);
});
