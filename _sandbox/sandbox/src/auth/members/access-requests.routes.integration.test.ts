import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { createApp } from "../../app.js";
import { postJson, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { ForbiddenError,fileMembersStore } from "../auth.js";
import { fileAccessRequests } from "./access-requests.js";

// A person refused something asks the owner for it from where they were (POST /members/requests); the owner reads the
// requests beside the roster, and granting the person anything answers theirs. Their own answer says they asked, so the
// editor draws "asked" rather than the press again.

const sandbox = async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-requests-"));
    const members = fileMembersStore(join(dir, "members.json"));
    const accessRequests = fileAccessRequests(dir);
    await members.add("rin@example.com", { role: "viewer" });
    // Each caller is the app as that person signs in to it: the owner, or a member at their tier.
    const as = (email: string, role: MemberRole) =>
        createApp(
            services({
                auth: {
                    authorize: async () => proven(email, role),
                    authorizeOwner: async () => {
                        if (role !== "owner") {
                            throw new ForbiddenError("not the sandbox owner");
                        }
                    },
                },
                ownerEmail: async () => "ada@example.com",
                members,
                accessRequests,
            }),
        );
    return { owner: as("ada@example.com", "owner"), rin: as("rin@example.com", "viewer"), accessRequests };
};

const getJson = async (app: ReturnType<typeof createApp>, path: string): Promise<{ status: number; body: unknown }> => {
    const response = await app.request(path);
    return { status: response.status, body: await response.json() };
};

test("a member asks from where they were refused, and their own answer says they asked", async () => {
    const { rin, accessRequests } = await sandbox();
    const asked = await postJson(rin, "/members/requests", { want: "maintainer", place: "Secrets" });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ role: "viewer", agents: "run", edit: "all", askedAt: expect.any(Number) });
    expect(await accessRequests.list()).toEqual([{ email: "rin@example.com", want: "maintainer", place: "Secrets", at: expect.any(Number) }]);

    // A later ask replaces theirs: one open request per person.
    await postJson(rin, "/members/requests", { want: "collaborator", place: "Chat" });
    expect(await accessRequests.list()).toEqual([{ email: "rin@example.com", want: "collaborator", place: "Chat", at: expect.any(Number) }]);
});

test("an ask that says nothing, and the owner asking, are refused", async () => {
    const { owner, rin } = await sandbox();
    expect((await postJson(rin, "/members/requests", { want: "everything", place: "Secrets" })).status).toBe(400);
    expect((await postJson(rin, "/members/requests", { want: "maintainer" })).status).toBe(400);
    expect((await postJson(owner, "/members/requests", { want: "maintainer", place: "Secrets" })).status).toBe(400);
});

test("only the owner reads and dismisses the requests", async () => {
    const { owner, rin } = await sandbox();
    await postJson(rin, "/members/requests", { want: "maintainer", place: "Secrets" });

    expect((await getJson(rin, "/members/requests")).status).toBe(403);
    const listed = await getJson(owner, "/members/requests");
    expect(listed).toEqual({ status: 200, body: { requests: [{ email: "rin@example.com", want: "maintainer", place: "Secrets", at: expect.any(Number) }] } });

    const dismissed = await owner.request("/members/requests", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Rin@Example.com" }),
    });
    expect(await dismissed.json()).toEqual({ requests: [] });
    expect((await getJson(rin, "/members/self")).body).toEqual({ role: "viewer", agents: "run", edit: "all" });
});

test("granting the person anything answers what they asked", async () => {
    const { owner, rin, accessRequests } = await sandbox();
    await postJson(rin, "/members/requests", { want: "collaborator", place: "Chat" });
    expect((await postJson(owner, "/members", { email: "rin@example.com", role: "collaborator" })).status).toBe(200);
    expect(await accessRequests.list()).toEqual([]);
});
