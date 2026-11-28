import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@intentic/base/async";
import { SETTLES } from "@intentic/testing/bun";
import { pino } from "pino";
import { createApp } from "../../app.js";
import { services } from "../../harness/route-services.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { createAuthorizer } from "../auth.js";
import { createAuthSlice } from "../auth-slice.js";
import { createAuthConnections } from "../connections.js";

// A control token a maintainer minted is that maintainer's authority, held by a program: when the owner takes the
// authority away (removing them, or re-grading them below maintainer), the token goes with it, as their sign-in does.
// Driven through the slice's own wiring, so the check is the one a running daemon makes.

const OWNER = "ada@example.com";
const MAINTAINER = "max@example.com";

const sandbox = async () => {
    const root = mkdtempSync(join(tmpdir(), "control-minter-"));
    const slice = createAuthSlice({ ...testConfig, historyRoot: join(root, "history") }, join(root, "work"), pino({ level: "silent" }));
    await slice.members.add(MAINTAINER, { tier: "maintainer" });
    const emails: Record<string, string> = { "tok-owner": OWNER, "tok-max": MAINTAINER };
    const authorizer = createAuthorizer({
        verify: async (bearer) => {
            const email = emails[bearer];
            if (email === undefined) {
                throw new Error("not a test bearer");
            }
            return { email };
        },
        owner: { read: async () => OWNER, write: async () => undefined },
        members: slice.members,
    });
    const app = createApp(
        services({
            auth: { ...authorizer, connections: createAuthConnections() },
            members: slice.members,
            controlTokens: slice.controlTokens,
            ownerEmail: async () => OWNER,
        }),
    );
    const as = (bearer: string, method: string, path: string, body?: unknown) =>
        app.request(path, {
            method,
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const minted = await as("tok-max", "POST", "/system/control/tokens", { label: "max's CI", scope: "land" });
    expect(minted.status).toBe(200);
    // SAFETY: a 200 from the mint route is always the store's { id, token }, checked just above.
    const { id, token } = (await minted.json()) as { id: string; token: string };
    const withToken = async (): Promise<number> => (await app.request("/agents", { headers: { "x-intentic-control": token } })).status;
    return { app, as, id, token, withToken };
};

const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, matches: (text: string) => boolean): Promise<"closed" | "matched"> => {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
        const next = await reader.read();
        if (next.done) {
            return "closed";
        }
        text += decoder.decode(next.value, { stream: true });
        if (matches(text)) {
            return "matched";
        }
    }
};

test("a maintainer's control token stops working once the owner removes them", async () => {
    const { as, withToken } = await sandbox();
    expect(await withToken()).toBe(200);

    expect((await as("tok-owner", "DELETE", "/members", { email: MAINTAINER })).status).toBe(200);

    expect((await as("tok-max", "GET", "/agents")).status).toBe(403);
    expect(await withToken()).toBe(401);
});

test("a maintainer's control token stops working once they are re-graded below maintainer", async () => {
    const { as, withToken } = await sandbox();
    expect((await as("tok-owner", "POST", "/members", { email: MAINTAINER, tier: "collaborator" })).status).toBe(200);
    expect(await withToken()).toBe(401);
});

test("revoking a control token cuts the event stream it holds open, not only its next request", async () => {
    const { app, as, id, token } = await sandbox();
    const stream = await app.request("/events", { headers: { "x-intentic-control": token } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    try {
        // The event after hello comes from the loop, which starts only once the stream is registered.
        const ready = readUntil(reader, (text) => (text.match(/^data:/gm)?.length ?? 0) >= 2);
        expect(await withTimeout(ready, SETTLES.timeout, "the stream did not send an event after hello")).toBe("matched");

        expect((await as("tok-owner", "DELETE", `/system/control/tokens/${id}`)).status).toBe(200);

        const closed = readUntil(reader, () => false);
        expect(await withTimeout(closed, SETTLES.timeout, "the revoked stream stayed open")).toBe("closed");
        expect((await app.request("/events", { headers: { "x-intentic-control": token } })).status).toBe(401);
    } finally {
        await reader.cancel();
    }
});
