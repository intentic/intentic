import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicContract } from "@intentic/sandbox-contract";
import { SHARE_DIR } from "@intentic/sandbox-contract/share-paths";
import { PUBLIC_DIR } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";
import { errorCode, routesClient } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createPublicRoutes, type PublicRoutesDeps } from "./public.routes.js";

/* The owner's side of the outbox. `unpublish` is the destructive one: it takes a path from the browser and hands
 * it to a recursive rm, so what it refuses matters more than what it removes. */

// A workspace with an outbox holding one ordinary file and one published conversation.
const outboxWorkspace = async (): Promise<ReturnType<typeof workspacePaths>> => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-public-"));
    await mkdir(join(root, PUBLIC_DIR, SHARE_DIR), { recursive: true });
    await writeFile(join(root, PUBLIC_DIR, "notes.md"), "# published");
    await writeFile(join(root, PUBLIC_DIR, SHARE_DIR, "index.html"), "<h1>a shared conversation</h1>");
    return workspacePaths(root);
};

const publicDeps = (workspace: ReturnType<typeof workspacePaths>, overrides: Partial<PublicRoutesDeps> = {}): PublicRoutesDeps => ({
    config: { ...testConfig, zone: "example.com", connectToken: "tok" },
    workspace,
    ...overrides,
});

const client = (workspace: ReturnType<typeof workspacePaths>) => routesClient(publicContract, createPublicRoutes(publicDeps(workspace)));

/* Shared conversations live in the outbox but are withdrawn by their own action, which also drops the row that
 * promises the link. The guard compared the raw input against the reserved name while the rm took the RESOLVED
 * path, so the two disagreed about every spelling but the literal one, and `./conversations` recursively removed
 * every published page while the /share rows survived to promise links that answer nothing. */
test("unpublish refuses the share directory however the path is spelled", async () => {
    const workspace = await outboxWorkspace();
    const shared = join(workspace.root, PUBLIC_DIR, SHARE_DIR, "index.html");
    for (const path of [SHARE_DIR, `./${SHARE_DIR}`, `x/../${SHARE_DIR}`, `${SHARE_DIR}/abc`]) {
        expect(await errorCode(client(workspace).unpublish({ path })), path).toBe("BAD_REQUEST");
        expect(existsSync(shared), path).toBe(true);
    }
});

test("unpublish withdraws an ordinary published file", async () => {
    const workspace = await outboxWorkspace();
    await expect(client(workspace).unpublish({ path: "notes.md" })).resolves.toEqual({ ok: true });
    expect(existsSync(join(workspace.root, PUBLIC_DIR, "notes.md"))).toBe(false);
    // The share tree is untouched by an unrelated withdrawal.
    expect(existsSync(join(workspace.root, PUBLIC_DIR, SHARE_DIR, "index.html"))).toBe(true);
});

test("unpublish refuses a path that leaves the outbox", async () => {
    const workspace = await outboxWorkspace();
    const outside = join(workspace.root, "keep.txt");
    await writeFile(outside, "not published");
    expect(await errorCode(client(workspace).unpublish({ path: "../keep.txt" }))).toBe("BAD_REQUEST");
    expect(existsSync(outside)).toBe(true);
});

// The list is the owner's honest inventory, and the shared conversations are deliberately not in it: they have
// their own list, with their own titles and their own withdraw action.
test("list reports published files and omits the shared conversations", async () => {
    const workspace = await outboxWorkspace();
    const listed = await client(workspace).list();
    expect(listed.files.map((file) => file.path)).toEqual(["notes.md"]);
});
