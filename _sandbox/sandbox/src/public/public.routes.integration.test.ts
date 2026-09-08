import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicContract } from "@intentic/sandbox-contract";
import { SHARE_DIR } from "@intentic/sandbox-contract/share-paths";
import { PUBLIC_DIR } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";
import { errorCode, routesClient } from "../harness/route-client.testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createPublicRoutes, type PublicRoutesDeps } from "./public.routes.js";

// The owner's side of the outbox; unpublish feeds a browser path to a recursive rm, so refusals matter most.

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

// Must compare the resolved path, not the raw input, or a spelling like `./share` would bypass the guard while rm
// removes it and the link row still promises it.
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

// Shared conversations aren't in this list; they have their own list, titles, and withdraw action.
test("list reports published files and omits the shared conversations", async () => {
    const workspace = await outboxWorkspace();
    const listed = await client(workspace).list();
    expect(listed.files.map((file) => file.path)).toEqual(["notes.md"]);
});
