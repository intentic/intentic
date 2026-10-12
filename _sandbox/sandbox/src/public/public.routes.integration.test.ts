import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { publicContract } from "@intentic/sandbox-contract";
import { SHARE_DIR } from "@intentic/sandbox-contract/share-paths";
import { PUBLIC_DIR } from "@intentic/workspace-ignore";
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

// A folder linking into the vault passes a lexical check (`notes/k/x.json` names no control-plane path) while the copy
// follows the link: the vault's bytes would be served to anyone with the link.
test("publish refuses a file reached through a symlinked folder into the control plane", async () => {
    const workspace = await outboxWorkspace();
    const vault = join(workspace.root, STATE_DIR, "secrets/auth");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "x.json"), '{"token":"secret"}');
    await mkdir(join(workspace.root, "notes"));
    await symlink(vault, join(workspace.root, "notes/k"));
    expect(await errorCode(client(workspace).publish({ path: "notes/k/x.json" }))).toBe("FORBIDDEN");
    expect(await readdir(join(workspace.root, PUBLIC_DIR))).not.toContain("x.json");
});

test("publish refuses a file reached through a symlinked folder out of the workspace", async () => {
    const workspace = await outboxWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "sandbox-public-outside-"));
    await writeFile(join(outside, "host.txt"), "host secret");
    await symlink(outside, join(workspace.root, "away"));
    expect(await errorCode(client(workspace).publish({ path: "away/host.txt" }))).toBe("BAD_REQUEST");
    expect(await readdir(join(workspace.root, PUBLIC_DIR))).not.toContain("host.txt");
});

test("publish copies an ordinary file", async () => {
    const workspace = await outboxWorkspace();
    await writeFile(join(workspace.root, "report.md"), "# report");
    await expect(client(workspace).publish({ path: "report.md" })).resolves.toMatchObject({ path: "report.md" });
    expect(await readFile(join(workspace.root, PUBLIC_DIR, "report.md"), "utf8")).toBe("# report");
});

// A folder in the outbox linking elsewhere would carry a recursive rm out of it while the path still reads as inside.
test("unpublish refuses a path through a symlinked folder, and leaves what it points at", async () => {
    const workspace = await outboxWorkspace();
    const kept = join(workspace.root, STATE_DIR, "secrets/auth");
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, "x.json"), "{}");
    await symlink(kept, join(workspace.root, PUBLIC_DIR, "k"));
    expect(await errorCode(client(workspace).unpublish({ path: "k/x.json" }))).toBe("BAD_REQUEST");
    expect(existsSync(join(kept, "x.json"))).toBe(true);
    // The link itself is the outbox's own entry, and withdrawing it takes the link only.
    await expect(client(workspace).unpublish({ path: "k" })).resolves.toEqual({ ok: true });
    expect(existsSync(join(workspace.root, PUBLIC_DIR, "k"))).toBe(false);
    expect(existsSync(join(kept, "x.json"))).toBe(true);
});

test("unpublish refuses a link that names the share folder", async () => {
    const workspace = await outboxWorkspace();
    await symlink(join(workspace.root, PUBLIC_DIR, SHARE_DIR), join(workspace.root, PUBLIC_DIR, "alias"));
    expect(await errorCode(client(workspace).unpublish({ path: "alias/index.html" }))).toBe("BAD_REQUEST");
    expect(existsSync(join(workspace.root, PUBLIC_DIR, SHARE_DIR, "index.html"))).toBe(true);
});
