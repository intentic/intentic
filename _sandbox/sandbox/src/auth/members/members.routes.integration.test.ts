import { WORKSPACE_ROOT } from "@intentic/constants";
import { createApp } from "../../app.js";
import { clientFor, postJson, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryAreasStore } from "../../harness/route-stores.testing.js";
import { fileMembersStore } from "../auth.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

// Whether the platform's identity assertion opens the sandbox for a person is the owner's call per member, carried on
// the grant; a re-grade from an editor that predates it keeps what the row said.
test("a grant carries a member's email sign-in, a re-grade without it keeps it, and the owner can take it back", async () => {
    const { app } = await ownerApp();
    const allowed = await postJson(app, "/members", { email: "Bo@Example.org", role: "viewer", emailSignIn: true });
    expect(await allowed.json()).toEqual({ members: [{ email: "bo@example.org", role: "viewer", emailSignIn: true }] });
    const regraded = await postJson(app, "/members", { email: "bo@example.org", role: "collaborator" });
    expect(await regraded.json()).toEqual({ members: [{ email: "bo@example.org", role: "collaborator", emailSignIn: true }] });
    const withdrawn = await postJson(app, "/members", { email: "bo@example.org", role: "collaborator", emailSignIn: false });
    expect(await withdrawn.json()).toEqual({ members: [{ email: "bo@example.org", role: "collaborator" }] });
    expect((await postJson(app, "/members", { email: "bo@example.org", role: "viewer", emailSignIn: "yes" })).status).toBe(400);
});

const FILM = join(WORKSPACE_ROOT, "film.mp4");

// A media or download ticket lives for hours; a person removed from the roster must not keep fetching with one.
test("removing a member drops the media tickets they minted, and nobody else's", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "members-")), "members.json");
    const members = fileMembersStore(path);
    await members.add("dee@example.com", { role: "viewer" });
    const owned = services({
        auth: { authorize: async () => proven(`ada@example.com`, `owner`), authorizeOwner: async () => undefined },
        ownerEmail: async () => `ada@example.com`,
        members,
    });
    const dee = owned.mediaTickets.mint(FILM, undefined, "dee@example.com").ticket;
    const ada = owned.mediaTickets.mint(FILM, undefined, "ada@example.com").ticket;

    const removed = await createApp(owned).request("/members", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "dee@example.com" }),
    });
    expect(removed.status).toBe(200);
    expect(owned.mediaTickets.valid(dee, FILM)).toBe(false);
    expect(owned.mediaTickets.valid(ada, FILM)).toBe(true);
});

// A roster this build cannot read is refused rather than replaced: the grant answers as this sandbox's fault to fix,
// and the file stays as it was.
test("a grant over a roster that cannot be read answers 503 and leaves the file as it was", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "members-")), "members.json");
    await writeFile(path, "{ this is not json", "utf8");
    const unreadable = createApp(
        services({
            auth: { authorize: async () => proven(`ada@example.com`, `owner`), authorizeOwner: async () => undefined },
            ownerEmail: async () => `ada@example.com`,
            members: fileMembersStore(path),
        }),
    );
    const granted = await postJson(unreadable, "/members", { email: "fay@example.com", role: "viewer" });
    expect(granted.status).toBe(503);
    expect(await granted.json()).toEqual({ error: expect.stringContaining("members.json could not be read by this build") });
    expect(await readFile(path, "utf8")).toBe("{ this is not json");
});

// What a person's conversations may spend rides on the grant: `all` lifts a reach, a list sets one, and a re-grade that
// never mentions it keeps it, so an editor that predates the field can never widen it. A maintainer is refused one.
test("a grant sets, keeps and lifts what a member's conversations may spend, and a maintainer cannot be limited", async () => {
    const { app, members } = await ownerApp();
    const reach = { capabilities: ["github"], secrets: ["DATABASE_URL"] };
    expect((await postJson(app, "/members", { email: "bob@example.com", role: "collaborator", credentials: reach })).status).toBe(200);
    expect((await postJson(app, "/members", { email: "bob@example.com", role: "viewer" })).status).toBe(200);
    expect(await members.list()).toEqual([{ email: "bob@example.com", role: "viewer", credentials: reach }]);

    const maintainer = await postJson(app, "/members", { email: "bob@example.com", role: "maintainer", credentials: reach });
    expect(maintainer.status).toBe(400);
    expect(await maintainer.json()).toEqual({ error: expect.stringContaining("cannot be limited") });

    // Graded up to maintainer without naming a reach, the row drops it rather than keeping one nothing enforces.
    expect((await postJson(app, "/members", { email: "bob@example.com", role: "maintainer" })).status).toBe(200);
    expect(await members.list()).toEqual([{ email: "bob@example.com", role: "maintainer" }]);

    expect((await postJson(app, "/members", { email: "bob@example.com", role: "collaborator", credentials: reach })).status).toBe(200);
    expect((await postJson(app, "/members", { email: "bob@example.com", role: "collaborator", credentials: "all" })).status).toBe(200);
    expect(await members.list()).toEqual([{ email: "bob@example.com", role: "collaborator" }]);
});

// Access is three answers, and the role a grant names must be the tier they make: a person who sees the whole workspace
// and edits one area of it, with agents off, is a writer; the same answers named as anything else are refused.
test("a grant carries agents and edit areas, and its role must be the tier they make", async () => {
    const { app, members } = await ownerApp();
    const editor = { email: "eli@example.com", role: "writer", agents: "off", edit: ["support"] };
    expect((await postJson(app, "/members", editor)).status).toBe(200);
    expect(await members.list()).toEqual([{ email: "eli@example.com", role: "writer", agents: "off", edit: ["support"] }]);

    const misnamed = await postJson(app, "/members", { ...editor, role: "collaborator" });
    expect(misnamed.status).toBe(400);
    expect(await misnamed.json()).toEqual({ error: "the role does not match the access granted, which makes a writer" });

    // Editing reaches only where they can see, and every area named for editing exists.
    const unseen = await postJson(app, "/members", { ...editor, areas: ["finance"] });
    expect(unseen.status).toBe(400);
    expect(await unseen.json()).toEqual({ error: expect.stringContaining("support is not among their areas") });
    expect((await postJson(app, "/members", { ...editor, edit: ["sales"] })).status).toBe(400);
    expect((await postJson(app, "/members", { ...editor, areas: ["support"], edit: "all" })).status).toBe(400);
});

// The editor asks what its own grant allows; the answer is the request's own identity, never the roster's raw row.
test("GET /members/self answers the caller's own access", async () => {
    const owned = await ownerApp();
    expect(await (await owned.app.request("/members/self", { headers: { authorization: "Bearer owner" } })).json()).toEqual({
        role: "owner",
        agents: "run",
        edit: "all",
    });
    const members = fileMembersStore(join(await mkdtemp(join(tmpdir(), "members-")), "members.json"));
    const app = createApp(
        services({
            auth: {
                authorize: async () => ({ ...proven(`eli@example.com`, `writer`), agents: `off`, edits: [`support`] }),
                authorizeOwner: async () => undefined,
            },
            ownerEmail: async () => `ada@example.com`,
            members,
        }),
    );
    expect(await (await app.request("/members/self", { headers: { authorization: "Bearer eli" } })).json()).toEqual({
        role: "writer",
        agents: "off",
        edit: ["support"],
    });
});
