import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, deviceScopesOn } from "@intentic/sandbox-contract/schemas/capabilities";
import type { NeedRaise, NeedRaised } from "@intentic/sandbox-contract/schemas/needs";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../../app.js";
import { grantsOf } from "../../auth/grants.js";
import type { ControlTokens } from "../../auth/tokens/control-tokens.js";
import { memoryCapabilitiesStore } from "../../capabilities/capabilities-slice.testing.js";
import type { Services } from "../../composition.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { provenTurnHeaders } from "../../seams/workload-stamp.testing.js";
import { fileStackGrants, stackGrantsDocument } from "./stack-grants.js";

// The owner's stack grants (stack-grants.ts): one per repository, stack and computer in the auth root, widened by name,
// refused rather than read as empty when the file cannot be read, given and taken back over the routes by a person
// holding the Secrets right, asked for by an agent on a card, and out of every agent's and extension's reach otherwise.

let state: string;

beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), "intentic-stack-grants-"));
});

afterEach(async () => {
    await rm(state, { recursive: true, force: true });
});

const AT = new Date("2026-11-25T12:00:00.000Z");
const WEB_ON_ROG = { repo: "shop", stack: "web", device: "rog" };

test("a grant is one per repository, stack and computer: granting more widens it, and revoking takes only that computer's", async () => {
    const grants = fileStackGrants(join(state, stackGrantsDocument.path), () => AT);
    await grants.add(WEB_ON_ROG, ["B", "A"], "owner@example.com");
    await grants.add({ ...WEB_ON_ROG, device: "z440" }, ["A"], undefined);
    expect(await grants.add(WEB_ON_ROG, ["A", "C"], undefined)).toEqual({ ...WEB_ON_ROG, secrets: ["A", "B", "C"], grantedAt: AT.toISOString() });
    await grants.add({ ...WEB_ON_ROG, stack: "api" }, ["D"], undefined);
    // Moved to another computer, a stack asks again.
    expect(await grants.forStack({ ...WEB_ON_ROG, device: "omen" })).toBeUndefined();
    expect(await grants.revoke(WEB_ON_ROG)).toBe(true);
    expect(await grants.revoke(WEB_ON_ROG)).toBe(false);
    expect((await grants.list()).map((grant) => `${grant.stack}@${grant.device}:${grant.secrets.join(",")}`)).toEqual(["web@z440:A", "api@rog:D"]);
});

test("a grants file this build cannot read is never read as nothing granted, and nothing is written over it", async () => {
    const path = join(state, stackGrantsDocument.path);
    await writeFile(path, "{ not json");
    const grants = fileStackGrants(path);
    await expect(grants.list()).rejects.toThrow(`the stack grants at ${path} could not be read`);
    await expect(grants.add(WEB_ON_ROG, ["A"], undefined)).rejects.toThrow("could not be read by this build");
});

test("the agent token reaches the read and the ask for a grant, and never the grant or its revoking", async () => {
    const agent = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: unstubbed<ControlTokens>("controlTokens", {}),
        verifySync: async () => ({ kind: "enrolled", id: "laptop", card: "laptop" }),
        verifyExtension: () => undefined,
    }).find((grant) => grant.header === "x-intentic-agent");
    const reaches = async (method: string, path: string): Promise<string | undefined> => (await agent?.authorize("agent", method, path))?.verdict;
    expect({
        list: await reaches("GET", "/stack-grants"),
        request: await reaches("POST", "/stack-grants/request"),
        grant: await reaches("POST", "/stack-grants/grant"),
        revoke: await reaches("POST", "/stack-grants/revoke"),
    }).toEqual({ list: "ok", request: "ok", grant: "out-of-scope", revoke: "out-of-scope" });
});

const ROG: Capability = { id: "rog", kind: "device", config: { ...deviceScopesOn(["shell"]), platform: "linux" } };

test("the owner grants a stack exactly the names asked, on a paired computer, and takes the grant back, over the routes", async () => {
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([ROG]) })));

    const { grants } = await client.stackGrants.grant({ ...WEB_ON_ROG, secrets: ["DB_URL", "API_TOKEN"] });

    expect(grants).toEqual([{ ...WEB_ON_ROG, secrets: ["API_TOKEN", "DB_URL"], grantedAt: expect.any(String) }]);
    expect(await client.stackGrants.list()).toEqual({ grants });
    expect(await client.stackGrants.revoke(WEB_ON_ROG)).toEqual({ ok: true });
    expect(await errorCode(client.stackGrants.revoke(WEB_ON_ROG))).toBe("NOT_FOUND");
    expect(await errorCode(client.stackGrants.grant({ ...WEB_ON_ROG, device: "omen", secrets: ["A"] }))).toBe("BAD_REQUEST");
    expect(await client.stackGrants.list()).toEqual({ grants: [] });
});

test("a person without the Secrets right can neither grant nor revoke, whatever floor the route lets them through", async () => {
    const svc = services({
        capabilities: memoryCapabilitiesStore([ROG]),
        auth: { authorize: async () => proven("c@example.com", "collaborator"), authorizeOwner: rejectForbidden },
    });
    const client = clientFor(createApp(svc), { bearer: "c@example.com" });
    expect(await errorCode(client.stackGrants.grant({ ...WEB_ON_ROG, secrets: ["A"] }))).toBe("FORBIDDEN");
    await svc.stackGrants.add(WEB_ON_ROG, ["A"], undefined);
    expect(await errorCode(client.stackGrants.revoke(WEB_ON_ROG))).toBe("FORBIDDEN");
    expect(await svc.stackGrants.list()).toMatchObject([{ ...WEB_ON_ROG, secrets: ["A"] }]);
});

test("an agent's ask raises the deploy card in its own conversation, naming the stack, the computer and the secrets", async () => {
    const asked: { readonly raise: NeedRaise; readonly conversationId: string | undefined }[] = [];
    const raised: NeedRaised = { state: "open", message: "Asked the owner to let web on rog receive the secret DB_URL." };
    const needs = unstubbed<Services["needs"]>("needs", {
        ask: async ({ raise, conversationId }) => {
            asked.push({ raise, conversationId });
            return raised;
        },
    });
    const app = createApp(services({ needs }));
    const response = await app.request("/stack-grants/request", {
        method: "POST",
        headers: { ...provenTurnHeaders("conv-7"), "content-type": "application/json" },
        body: JSON.stringify({ ...WEB_ON_ROG, secrets: ["DB_URL"], why: "the new release reads DB_URL" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(raised);
    expect(asked).toEqual([
        { raise: { ask: { kind: "deploy", ...WEB_ON_ROG, secrets: ["DB_URL"] }, why: "the new release reads DB_URL" }, conversationId: "conv-7" },
    ]);
});
