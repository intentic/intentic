import { test, expect } from "bun:test";

import { createApp } from "../../app.js";
import { clientFor, postJson, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryAreasStore } from "../../harness/route-stores.testing.js";
import { fileMembersStore } from "../auth.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Granting a guest over /members: the grant names areas, and the daemon refuses one it could never honour — an
// unfenced guest, an area nobody wrote, and a fence no assistant works in.

const ownerApp = async () => {
    const members = fileMembersStore(join(await mkdtemp(join(tmpdir(), "members-")), "members.json"));
    const app = createApp(
        services({
            auth: { authorize: async () => proven(`ada@example.com`, `owner`), authorizeOwner: async () => undefined },
            ownerEmail: async () => `ada@example.com`,
            members,
            areas: memoryAreasStore([
                { id: `support`, folders: [`support`] },
                { id: `finance`, folders: [`finance`] },
            ]),
        }),
    );
    // One card, homed in the support folder: what makes `support` an area a guest can be fenced to, and `finance` one
    // it cannot.
    await clientFor(app, { bearer: `owner` }).personas.save({ id: `support`, capabilities: [], workspace: { startIn: `support` } });
    return { app, members };
};

test("a guest grant names at least one area, and the areas it names exist", async () => {
    const { app, members } = await ownerApp();
    expect((await postJson(app, "/members", { email: "dee@example.com", role: "guest" })).status).toBe(400);
    expect((await postJson(app, "/members", { email: "dee@example.com", role: "guest", areas: [] })).status).toBe(400);
    const missing = await postJson(app, "/members", { email: "dee@example.com", role: "guest", areas: ["support", "sales"] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "no such area: sales" });
    expect(await members.list()).toEqual([]);

    const granted = await postJson(app, "/members", { email: "Dee@Example.com", role: "guest", areas: ["support"] });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ members: [{ email: "dee@example.com", role: "guest", areas: ["support"] }] });
});

// A guest reaches its assistants and nothing else, so a fence holding none is a sign-in to a chat that answers
// nothing. Every other tier has business in an area no card works in.
test("a guest fenced to areas no assistant works in is refused; another tier there is not", async () => {
    const { app, members } = await ownerApp();
    const stranded = await postJson(app, "/members", { email: "dee@example.com", role: "guest", areas: ["finance"] });
    expect(stranded.status).toBe(400);
    expect(await stranded.json()).toEqual({ error: expect.stringContaining("no assistant works in those areas") });
    expect(await members.list()).toEqual([]);

    expect((await postJson(app, "/members", { email: "fay@example.com", role: "viewer", areas: ["finance"] })).status).toBe(200);
});
