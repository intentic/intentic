import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { createApp } from "../../app.js";
import { rejectAuth } from "../../auth/auth-slice.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { automationRecord } from "../../harness/route-stores.testing.js";
import { memoryAutomationsStore } from "../automations-slice.testing.js";

// The webhook door with a signature scheme on it: the provider's signature is required on top of the door's token,
// a redelivery of a call already taken answers `duplicate` across a restart of the ledger, and an unsigned webhook
// still takes its token alone.

const SECRET = "gh-signing-secret-value";
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

const setup = async () => {
    const store = memoryAutomationsStore([
        automationRecord("signed", { trigger: { kind: "event", signature: { scheme: "github", secret: "GH_HOOK" } }, prompt: "handle it" }),
        automationRecord("unset", { trigger: { kind: "event", signature: { scheme: "github", secret: "NOT_SET" } }, prompt: "x" }),
        automationRecord("plain", { trigger: { kind: "event" }, prompt: "handle it" }),
    ]);
    const config = { ...testConfig, historyRoot: mkdtempSync(join(tmpdir(), "fire-signed-")) };
    const composed = services({ automations: store, config, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } });
    await composed.sandboxSecrets.set("GH_HOOK", SECRET);
    const tokens = {
        signed: await composed.doorTokens.ensure("automation", "signed"),
        unset: await composed.doorTokens.ensure("automation", "unset"),
        plain: await composed.doorTokens.ensure("automation", "plain"),
    };
    const app = createApp(composed);
    const fire = (id: keyof typeof tokens, body: string, headers: Record<string, string> = {}) =>
        app.request(`/automations/${id}/fire?token=${tokens[id]}`, { method: "POST", body, headers });
    return { store, fire, composed, config };
};

test("a signed webhook needs its provider's signature: the token alone, a bad signature and an unset secret are refused", async () => {
    const { fire } = await setup();
    const body = JSON.stringify({ action: "opened" });
    expect((await fire("signed", body)).status).toBe(401);
    expect((await fire("signed", body, { "x-hub-signature-256": sign("something else") })).status).toBe(401);
    expect((await fire("unset", body, { "x-hub-signature-256": sign(body) })).status).toBe(401);
    // A good signature without the door's token is still refused: the signature adds to the token, never replaces it.
    const { composed } = await setup();
    const app = createApp(composed);
    expect((await app.request("/automations/signed/fire", { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } })).status).toBe(401);
});

test("a signed delivery is queued once, its redelivery answers duplicate, and a ping wakes nothing", async () => {
    const { fire, store } = await setup();
    const body = JSON.stringify({ action: "opened", token: "do-not-keep" });
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "delivery-1", "x-github-event": "issues" };
    const first = await fire("signed", body, headers);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, receipt: "queued" });
    const again = await fire("signed", body, headers);
    expect(await again.json()).toEqual({ ok: true, receipt: "duplicate" });
    const ping = await fire("signed", "{}", { "x-hub-signature-256": sign("{}"), "x-github-delivery": "delivery-2", "x-github-event": "ping" });
    expect(await ping.json()).toEqual({ ok: true, receipt: "ignored" });
    await waitFor(async () => expect((await store.get("signed"))?.runs).toHaveLength(1), SETTLES);
});

test("the ledger is on the history volume, so a redelivery after a restart is still a duplicate", async () => {
    const first = await setup();
    const body = JSON.stringify({ action: "closed" });
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "delivery-9" };
    expect(await (await first.fire("signed", body, headers)).json()).toEqual({ ok: true, receipt: "queued" });
    // A fresh app over the same history root stands in for the restarted daemon.
    const composed = services({ automations: first.store, config: first.config, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } });
    await composed.sandboxSecrets.set("GH_HOOK", SECRET);
    const token = await composed.doorTokens.ensure("automation", "signed");
    const again = await createApp(composed).request(`/automations/signed/fire?token=${token}`, { method: "POST", body, headers });
    expect(await again.json()).toEqual({ ok: true, receipt: "duplicate" });
});

test("an unsigned webhook still fires on its token alone", async () => {
    const { fire, store } = await setup();
    const answer = await fire("plain", "payload");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, receipt: "queued" });
    await waitFor(async () => expect((await store.get("plain"))?.runs).toHaveLength(1), SETTLES);
});
