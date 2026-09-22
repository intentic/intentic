import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { MemberRole } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { test, expect } from "bun:test";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { clientFor, errorCode, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { fakeFiles, fakeHistory, tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryAreasStore } from "../harness/route-stores.testing.js";

// A fenced member over the daemon's own HTTP surface: what they may list, read, search and write. The path arithmetic
// is fence-paths.test.ts and the pruning is workspace-fence's; what is pinned here is that the routes actually ask.

// `support` holds one folder; `finance` is what the fenced member must never reach.
const AREAS = [
    { id: "support", folders: ["support"] },
    { id: "finance", folders: ["finance"] },
];

const TREE = {
    root: WORKSPACE_ROOT,
    tree: [
        { name: "support", path: "support", type: "dir" as const, children: [{ name: "faq.md", path: "support/faq.md", type: "file" as const }] },
        {
            name: "finance",
            path: "finance",
            type: "dir" as const,
            children: [{ name: "payroll.csv", path: "finance/payroll.csv", type: "file" as const }],
        },
    ],
    hidden: 0,
    barren: ["support", "finance"],
};

const guest = async (): Promise<{
    readonly client: ReturnType<typeof clientFor>;
    readonly app: ReturnType<typeof createApp>;
    readonly actAs: (role: MemberRole, areas?: readonly string[]) => void;
}> => {
    let caller = proven(`ada@example.com`, `owner`);
    const workspace = tempWorkspace([]);
    await mkdir(join(workspace.root, "support"), { recursive: true });
    await mkdir(join(workspace.root, "finance"), { recursive: true });
    await writeFile(join(workspace.root, "support", "faq.md"), "how to refund");
    await writeFile(join(workspace.root, "finance", "payroll.csv"), "name,amount");
    const app = createApp(
        services({
            workspace,
            files: fakeFiles(),
            history: fakeHistory(),
            workspaceTree: async () => TREE,
            workspaceChildren: async (_root, path) => ({ entries: TREE.tree.find((entry) => entry.path === path)?.children ?? [], hidden: 0 }),
            areas: memoryAreasStore(AREAS),
            auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
            ownerEmail: async () => `ada@example.com`,
        }),
    );
    return {
        client: clientFor(app, { bearer: `member` }),
        app,
        actAs: (role, areas) => (caller = proven(`fay@example.com`, role, [`google`], areas)),
    };
};

test("a fenced member's tree holds their own folders and nothing beside them", async () => {
    const { client, actAs } = await guest();
    actAs(`viewer`, [`support`]);
    const tree = await client.workspace.tree({});
    expect(tree.tree.map((entry) => entry.path)).toEqual(["support"]);
    // The barren list is a second path list over the same tree, and would otherwise name what the tree does not.
    expect(tree.barren).toEqual(["support"]);
});

test("an unfenced member still sees the whole tree, byte for byte as before", async () => {
    const { client, actAs } = await guest();
    actAs(`viewer`);
    expect(await client.workspace.tree({})).toEqual(TREE);
});

test("a read outside the fence is FORBIDDEN, and inside it is not", async () => {
    const { client, actAs } = await guest();
    actAs(`viewer`, [`support`]);
    expect(await errorCode(client.workspace.file({ path: "finance/payroll.csv" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.workspace.file({ path: "support/faq.md" }))).toBeUndefined();
});

// The index covers the whole tree; without this the fence is decorative, since a query returns the lines themselves.
test("a fenced search runs inside the fence, and inside a folder outside it runs over nothing", async () => {
    const scopes: (readonly string[] | undefined)[] = [];
    let caller = proven(`fay@example.com`, `viewer`, [`google`], [`support`]);
    const client = clientFor(
        createApp(
            services({
                areas: memoryAreasStore(AREAS),
                auth: { authorize: async () => caller, authorizeOwner: rejectForbidden },
                iq: unstubbed<Services["iq"]>("iq", {
                    run: async (request) => {
                        scopes.push(request.scope.paths);
                        return {
                            result: { mode: "q", total: 0, files: 0, shown: 0, groups: [], freshness: { state: "fresh" }, truncated: false },
                        } as never;
                    },
                }),
            }),
        ),
        { bearer: `member` },
    );
    await client.workspace.search({ query: "salary" });
    await client.workspace.search({ query: "salary", dir: "finance" });
    await client.workspace.search({ query: "salary", dir: "support/tickets" });
    caller = proven(`ada@example.com`, `owner`);
    await client.workspace.search({ query: "salary" });
    // Fenced with no folder asked for: the fence itself. Asked for a folder outside it: nothing, which the engine's
    // own prefix filter renders as no results. Asked for one inside it: the narrower of the two. Unfenced: no scope.
    expect(scopes).toEqual([["support"], [], ["support/tickets"], undefined]);
});

test("a fenced member may attach a file to a message but may not write into the workspace", async () => {
    const { app, actAs } = await guest();
    actAs(`collaborator`, [`support`]);
    const attachment = await app.request(`/workspace/upload?path=.intentic/records/artifacts/attachments/abc/note.txt`, {
        method: "POST",
        body: "hi",
    });
    expect(attachment.status).toBe(200);
    const elsewhere = await app.request(`/workspace/upload?path=finance/leak.csv`, { method: "POST", body: "hi" });
    expect(elsewhere.status).toBe(403);
});

// The write half of the same fence. The floor (auth/role-floor.ts) admits a writer to these routes at all; what is
// pinned here is that the path still has to be one the fence admits, on every door that changes the tree.
test("a writer changes files inside its areas and is refused on every route outside them", async () => {
    const { client, app, actAs } = await guest();
    actAs(`writer`, [`support`]);
    await expect(client.workspace.mkdir({ path: "support/tickets" })).resolves.toEqual({ ok: true });
    expect(await errorCode(client.workspace.mkdir({ path: "finance/tickets" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.workspace.delete({ path: "finance/payroll.csv" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.workspace.extract({ path: "finance/books.zip" }))).toBe("FORBIDDEN");
    // Both endpoints of a move are write targets, so carrying a file out of the fence is refused from either side.
    expect(await errorCode(client.workspace.move({ from: "support/faq.md", to: "finance/faq.md" }))).toBe("FORBIDDEN");
    expect(await errorCode(client.workspace.move({ from: "finance/payroll.csv", to: "support/payroll.csv" }))).toBe("FORBIDDEN");
    const inside = await app.request(`/workspace/upload?path=support/note.md`, { method: "POST", body: "hi" });
    expect(inside.status).toBe(200);
    const outside = await app.request(`/workspace/upload?path=finance/leak.csv`, { method: "POST", body: "hi" });
    expect(outside.status).toBe(403);
});

// The tier is an editor, not an operator: it changes files and has no way to move them into the owner's tree, read a
// credential, or operate the workspace it writes in.
test("a writer ships nothing it wrote", async () => {
    const { app, actAs } = await guest();
    actAs(`writer`, [`support`]);
    for (const path of [`/agents/abc/land`, `/workspace/setup`, `/workspace/repos`]) {
        expect((await app.request(path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
    }
    expect((await app.request(`/secrets`, { method: "GET" })).status).toBe(403);
});

// A fence has to be the shape of the workspace as far as this person is concerned, so an ancestor on the way down
// stays listable while its other branches do not.
test("a folder leading to the fence lists only what leads somewhere", async () => {
    const { client, actAs } = await guest();
    actAs(`viewer`, [`support`]);
    expect(await errorCode(client.workspace.children({ path: "finance" }))).toBe("FORBIDDEN");
    await expect(client.workspace.children({ path: "support" })).resolves.toEqual({
        entries: [{ name: "faq.md", path: "support/faq.md", type: "file" }],
        hidden: 0,
    });
});
