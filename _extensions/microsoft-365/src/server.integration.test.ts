import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import type { ToolCard } from "@intentic/extension-api";
import type { Verdict } from "./actions.js";
import { createServer } from "./server.js";
import { httpQueue, type MockAnswer } from "./testing.js";

// The backend as the host activates it, on the SDK's fake daemon, which refuses any daemon route the manifest does not
// declare: a send through it is allowed, denied or held by the owner's rule as the daemon answers it, a held one goes
// out only through `perform` after the yes, and the card's sign-in reaches the backend with the call, never the
// agent's environment.

// SAFETY: this extension's own manifest, which the daemon's schema parses; the fields read are named here.
const manifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8")) as {
    readonly publisher: string;
    readonly name: string;
    readonly permissions: { readonly daemon: readonly string[] };
    readonly contributes: { readonly capabilities: readonly { readonly env: Readonly<Record<string, string>>; readonly fields: readonly { readonly key: string; readonly secret?: boolean }[] }[] };
};

const card: ToolCard = { id: "office", config: { tenantId: "tenant", clientId: "client", refreshToken: "initial", access: "write" } };
const message = Buffer.from(JSON.stringify({ subject: "Wniosek", toRecipients: [{ emailAddress: { address: "someone@example.org" } }] })).toString("base64");
const send = { argv: ["mail", "send", "--file", "message.json"], files: { "message.json": message } };

// What the stood-in daemon answers the outward-action door with, set by each test.
interface Rules {
    verdict: Verdict;
}

interface DaemonCall {
    readonly method: string;
    readonly path: string;
    readonly body: { readonly hold?: { readonly digest: string }; readonly outcome?: string; readonly action?: string; readonly conversationId?: string } | undefined;
}

let running: FakeExtension | undefined;
afterEach(async () => {
    await running?.deactivate();
    await running?.dispose();
    running = undefined;
});

const start = async (answers: MockAnswer[]) => {
    const mock = httpQueue(answers);
    const daemon: DaemonCall[] = [];
    const rules: Rules = { verdict: { verdict: "allow" } };
    const extension = await fakeExtensionApi({
        manifest: { publisher: manifest.publisher, name: manifest.name, permissions: manifest.permissions },
        daemon: async (request) => {
            const path = new URL(request.url).pathname;
            // SAFETY: the backend's own typed calls, whose inputs carry these fields.
            const body = request.method === "GET" ? undefined : ((await request.json()) as DaemonCall["body"]);
            daemon.push({ method: request.method, path, body });
            if (path === "/capabilities/office/outward-action") {
                return Response.json(rules.verdict);
            }
            if (path === "/capabilities/office/connection") {
                return Response.json({ id: "office", kind: "cli", config: card.config });
            }
            return path.startsWith("/capabilities/office/") ? Response.json({ ok: true }) : undefined;
        },
    });
    running = extension;
    await extension.activate({ activateServer: createServer({ http: mock.http, pause: async () => {} }) });
    return { extension, calls: mock.calls, daemon, rules };
};

const MINT: MockAnswer = { body: { access_token: "access", expires_in: 3600 } };

test("each card gets the command runner, the sign-in and its status, and nothing for the extension itself", async () => {
    const { extension } = await start([]);
    expect((await extension.tools(card)).map((tool) => tool.name)).toEqual(["run", "sign_in", "sign_in_wait", "status"]);
    expect(await extension.tools()).toEqual([]);
    expect(JSON.parse(String(await extension.callTool("status", {}, card)))).toEqual({ id: "office", tenantId: "tenant", access: "write", signedIn: true });
});

test("an allowed send goes to Graph with the card's sign-in, and the daemon records how it went", async () => {
    const { extension, calls, daemon } = await start([MINT, { status: 202 }]);
    const answer = JSON.parse(String(await extension.callTool("run", send, card, { conversationId: "conv-1" })));
    expect(answer).toEqual({ output: { held: false }, files: [], downloads: [] });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/tenant/oauth2/v2.0/token", "/v1.0/me/sendMail"]);
    expect(new URLSearchParams(String(calls[0]!.init?.body)).get("refresh_token")).toBe("initial");
    expect(daemon.map((call) => call.path)).toEqual(["/capabilities/office/outward-action", "/capabilities/office/outward-action/outcome"]);
    expect(daemon[0]?.body).toMatchObject({ action: "mail.send", conversationId: "conv-1", hold: { digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(daemon[1]?.body).toMatchObject({ action: "mail.send", outcome: "ok" });
    expect(extension.calls.every((call) => call.admitted)).toBe(true);
});

test("a denied send is refused with the rule's reason, and nothing reaches Microsoft", async () => {
    const { extension, calls, rules } = await start([]);
    rules.verdict = { verdict: "deny", reason: "microsoft365 mail.send is refused by the action rules" };
    await expect(Promise.resolve(extension.callTool("run", send, card, { conversationId: "conv-1" }))).rejects.toThrow("refused by the action rules");
    expect(calls).toEqual([]);
});

test("a held send waits frozen for the yes, and only `perform` sends it, once and as frozen", async () => {
    const { extension, calls, daemon, rules } = await start([MINT, { status: 202 }]);
    rules.verdict = { verdict: "hold", reason: "requires owner approval", approvalId: "microsoft365-1" };
    const answer = JSON.parse(String(await extension.callTool("run", send, card, { conversationId: "conv-1" })));
    expect(answer.output).toEqual({ held: true, approvalId: "microsoft365-1" });
    expect(calls).toEqual([]);
    const digest = daemon[0]?.body?.hold?.digest ?? "";
    const held = join(extension.api.stateDir, "held");
    expect(await readdir(held)).toEqual([`${digest}.json`]);
    const approved = { id: "microsoft365-1", digest, summary: "Send", details: "", approvedAt: 1, actionRules: {} };
    expect(await extension.perform(approved)).toEqual({ outcome: "done", result: "Microsoft accepted it" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/tenant/oauth2/v2.0/token", "/v1.0/me/sendMail"]);
    expect(daemon.map((call) => call.path).slice(1)).toEqual([
        "/capabilities/office/connection",
        "/capabilities/office/outward-action",
        "/capabilities/office/outward-action/outcome",
    ]);
    // Asked again without a draft, so the daemon drafts nothing twice.
    expect(daemon[2]?.body?.hold).toBeUndefined();
    expect(await readdir(held)).toEqual([]);
    expect(await extension.perform(approved)).toMatchObject({ outcome: "refused" });
    expect(calls).toHaveLength(2);
});

test("an approved send is refused when what is held was edited after the yes, or a rule now denies it", async () => {
    const { extension, calls, daemon, rules } = await start([]);
    rules.verdict = { verdict: "hold", reason: "requires owner approval", approvalId: "microsoft365-2" };
    await extension.callTool("run", send, card, { conversationId: "conv-1" });
    const digest = daemon[0]?.body?.hold?.digest ?? "";
    const approved = { id: "microsoft365-2", digest, summary: "Send", details: "", approvedAt: 1, actionRules: {} };
    rules.verdict = { verdict: "deny", reason: "microsoft365 mail.send is refused by the action rules" };
    expect(await extension.perform(approved)).toEqual({ outcome: "refused", error: "microsoft365 mail.send is refused by the action rules" });
    rules.verdict = { verdict: "allow" };
    const file = join(extension.api.stateDir, "held", `${digest}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace("someone@example.org", "someone-else@example.org"));
    expect(await extension.perform(approved)).toEqual({ outcome: "refused", error: "the held request no longer matches what was approved" });
    expect(calls).toEqual([]);
});

test("the agent's environment carries the card's tenant and app, never its sign-in", () => {
    const spec = manifest.contributes.capabilities[0]!;
    const secrets = spec.fields.filter((field) => field.secret === true).map((field) => field.key);
    expect(secrets).toEqual(["refreshToken", "clientSecret"]);
    for (const template of Object.values(spec.env)) {
        expect(secrets.some((key) => template.includes(`\${${key}}`))).toBe(false);
    }
    expect(Object.keys(spec.env).toSorted()).toEqual(["M365_ACCESS", "M365_AUTHORITY", "M365_CLIENT_ID", "M365_TENANT_ID"]);
});

test("a device sign-in runs in the backend and stores its token on the card against the card's current one", async () => {
    const { extension, daemon } = await start([
        { body: { device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://login.microsoft.com/device", expires_in: 300, interval: 1 } },
        { body: { access_token: "a", refresh_token: "signed-in" } },
    ]);
    expect(await extension.callTool("sign_in", {}, card)).toBe(
        "Open https://login.microsoft.com/device in your own browser, enter the code ABCD-EFGH and sign in with the office account.",
    );
    expect(JSON.parse(String(await extension.callTool("sign_in_wait", {}, card)))).toMatchObject({ state: "done" });
    const stored = daemon.find((call) => call.path === "/capabilities/office/oauth-token");
    expect(stored?.body).toMatchObject({ previous: "initial", refreshToken: "signed-in", login: true });
});
