import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { ConversationBundleSchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Hono } from "hono";
import { z } from "zod";
import { createApp } from "../../app.js";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { clientFor, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { runAgentTurn } from "../../harness/route-turns.testing.js";
import { fileInboundLinks, inboundLinksDocument } from "../inbound-links.js";

// A link's records, both halves over HTTP: the taking sandbox answers its records doors only while the link's terms share
// them, and the asking sandbox's agent reaches them with `--on <link>` (relayed by its own daemon, which holds the token),
// besides asking its own records through `POST /diagnostics`.

const AGENT = { "x-intentic-agent": "agent-secret" };

interface Sandbox {
    readonly app: Hono<AppEnv>;
    readonly services: Services;
}

const sandbox = (cards: readonly Capability[] = []): Sandbox => {
    const base = services({
        inboundLinks: fileInboundLinks(join(mkdtempSync(join(tmpdir(), "records-")), inboundLinksDocument.path)),
        auth: { authorize: async () => proven("owner@example.com", "owner") },
        turnCheckpoints: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
        async *agent() {
            yield { kind: "session", sessionId: "sess-records" };
            yield { kind: "done" };
        },
        sessions: { list: async () => [], read: async () => [{ role: "user" as const, text: "why did the land fail" }], readTail: async () => [], search: async () => [], exists: async () => true },
    });
    const svc: Services = cards.length === 0 ? base : { ...base, capabilities: { ...base.capabilities, list: async () => [...cards] } };
    return { app: createApp(svc), services: svc };
};

const AnswerSchema = z.looseObject({});

const json = async (response: Response | Promise<Response>) => {
    const answered = await response;
    return { status: answered.status, body: AnswerSchema.parse(await answered.json()) };
};

const door = async (app: Hono<AppEnv>, path: string, token: string, body?: object): Promise<Response> => {
    if (body === undefined) {
        return app.request(`http://sandbox.test${path}`, { headers: { [LINK_HEADER]: token } });
    }
    return app.request(`http://sandbox.test${path}`, {
        method: "POST",
        headers: { [LINK_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
};

const diagnostics = async (app: Hono<AppEnv>, body: object): Promise<Response> =>
    app.request("http://sandbox.test/diagnostics", { method: "POST", headers: { ...AGENT, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the diagnostics command's door answers a query in the tools' words, and refuses one it cannot read", async () => {
    const { app } = sandbox();
    await runAgentTurn(clientFor(app), { prompt: "why did the land fail", conversationId: "fair-sage-ey2r", isolated: true });
    const timeline = await json(await diagnostics(app, { query: "timeline", conversationId: "fair-sage-ey2r" }));
    expect(timeline.status).toBe(200);
    expect(String(timeline.body["text"])).toContain("fair-sage-ey2r");
    expect((await json(await diagnostics(app, { query: "restarts" }))).status).toBe(200);
    expect((await diagnostics(app, { query: "everything" })).status).toBe(400);
    expect((await diagnostics(app, { query: "errors", from: "yesterday" })).status).toBe(400);
    // A link this sandbox does not hold is named as such, before anything is asked anywhere.
    const nowhere = await json(await diagnostics(app, { query: "restarts", on: "ops" }));
    expect(nowhere).toMatchObject({ status: 404, body: { message: expect.stringContaining("linked to no other sandbox") } });
});

test("a link reads no records until its owner shares them, then reads every door and nothing that writes", async () => {
    const { app, services: svc } = sandbox();
    await runAgentTurn(clientFor(app), { prompt: "why did the land fail", conversationId: "fair-sage-ey2r", isolated: true });
    const { id, token } = await svc.inboundLinks.mint("home", {});

    expect((await door(app, "/link/records/fleet", "ilk_not-a-link")).status).toBe(401);
    const refused = await json(await door(app, "/link/records/fleet", token));
    expect(refused).toMatchObject({ status: 403, body: { error: expect.stringContaining("does not share this sandbox's records") } });
    expect((await door(app, "/link/records/diagnostics", token, { query: "restarts" })).status).toBe(403);

    await svc.inboundLinks.update(id, { records: true });
    expect((await json(await door(app, "/link", token))).body).toMatchObject({ terms: { records: true } });
    const roster = await json(await door(app, "/link/records/fleet", token));
    expect(roster.body["agents"]).toMatchObject([{ id: "fair-sage-ey2r" }]);
    const show = await json(await door(app, "/link/records/fleet/fair-sage-ey2r?transcript=1", token));
    expect(show.body).toMatchObject({ agent: { id: "fair-sage-ey2r" }, transcript: { total: 1 } });
    expect((await door(app, "/link/records/fleet/nobody-here", token)).status).toBe(404);
    const bundle = ConversationBundleSchema.parse(await (await door(app, "/link/records/fleet/fair-sage-ey2r/bundle", token)).json());
    expect(bundle).toMatchObject({ conversation: "fair-sage-ey2r", transcript: { total: 1 } });
    const timeline = await json(await door(app, "/link/records/diagnostics", token, { query: "timeline", conversationId: "fair-sage-ey2r" }));
    expect(String(timeline.body["text"])).toContain("fair-sage-ey2r");
    expect((await door(app, "/link/records/diagnostics", token, { query: "nope" })).status).toBe(400);
    // Sharing records hands over no task door: the link still reaches only the conversations it opened.
    expect((await door(app, "/link/conversations/fair-sage-ey2r", token)).status).toBe(404);
});

describe("the asking side relays `--on <link>` through the card it holds", () => {
    let far: ServerType | undefined;
    afterEach(() => far?.close());

    test("ls, show, bundle and diagnostics come back as the linked sandbox answered them", async () => {
        const taking = sandbox();
        await runAgentTurn(clientFor(taking.app), { prompt: "why did the land fail", conversationId: "fair-sage-ey2r", isolated: true });
        const { id, token } = await taking.services.inboundLinks.mint("home", { terms: { records: true } });
        far = serve({ fetch: taking.app.fetch, port: 0, hostname: "127.0.0.1" });
        await new Promise((resolve) => far?.once("listening", resolve));
        // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
        const url = `http://127.0.0.1:${(far.address() as AddressInfo).port}`;
        const card = CapabilitySchema.parse({ id: "ops", kind: "link", config: { url, token, name: "Ops" } });
        const { app } = sandbox([card]);

        const roster = await json(await app.request("http://sandbox.test/fleet?on=ops", { headers: AGENT }));
        expect(roster).toMatchObject({ status: 200, body: { agents: [{ id: "fair-sage-ey2r" }] } });
        const unknown = await json(await app.request("http://sandbox.test/fleet/nobody-here?on=ops", { headers: AGENT }));
        expect(unknown).toMatchObject({ status: 404, body: { message: expect.stringContaining("No conversation answers") } });
        const bundle = await json(await app.request("http://sandbox.test/fleet/fair-sage-ey2r/bundle?on=ops", { headers: AGENT }));
        expect(bundle.body).toMatchObject({ kind: "intentic.conversation-bundle", conversation: "fair-sage-ey2r" });
        const timeline = await json(await diagnostics(app, { query: "timeline", conversationId: "fair-sage-ey2r", on: "ops" }));
        expect(timeline).toMatchObject({ status: 200, body: { sandbox: "Ops", text: expect.stringContaining("fair-sage-ey2r") } });
        expect((await json(await diagnostics(app, { query: "restarts", on: "elsewhere" }))).body).toMatchObject({ message: 'No linked sandbox is called "elsewhere". Linked here: ops.' });

        // Its owner stops sharing: the next read says so, in the far sandbox's own words.
        await taking.services.inboundLinks.update(id, { records: false });
        const stopped = await json(await app.request("http://sandbox.test/fleet?on=ops", { headers: AGENT }));
        expect(stopped).toMatchObject({ status: 403, body: { message: expect.stringContaining("does not share") } });
    });
});
