import { expect, test } from "vitest";

import { createApp } from "../../app.js";
import { clientFor, postJson, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { fileMembersStore } from "../auth.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Granting a desk over /members: the grant names the cards, and the daemon refuses one it could never honour.

const ownerApp = async () => {
    const members = fileMembersStore(join(await mkdtemp(join(tmpdir(), "members-")), "members.json"));
    const app = createApp(
        services({
            auth: { authorize: async () => proven(`ada@example.com`, `owner`), authorizeOwner: async () => undefined },
            ownerEmail: async () => `ada@example.com`,
            members,
        }),
    );
    await clientFor(app, { bearer: `owner` }).personas.save({ id: `support`, capabilities: [] });
    return { app, members };
};

test("a desk grant names at least one card the workspace has, and only a desk names any", async () => {
    const { app, members } = await ownerApp();
    expect((await postJson(app, "/members", { email: "dee@example.com", role: "desk" })).status).toBe(400);
    expect((await postJson(app, "/members", { email: "dee@example.com", role: "desk", desks: [] })).status).toBe(400);
    const missing = await postJson(app, "/members", { email: "dee@example.com", role: "desk", desks: ["support", "sales"] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "no such persona: sales" });
    expect((await postJson(app, "/members", { email: "vic@example.com", role: "viewer", desks: ["support"] })).status).toBe(400);
    expect(await members.list()).toEqual([]);

    const granted = await postJson(app, "/members", { email: "Dee@Example.com", role: "desk", desks: ["support"] });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ members: [{ email: "dee@example.com", role: "desk", desks: ["support"] }] });
});
