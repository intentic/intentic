import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { unstubbed } from "@intentic/testing";
import { defaultGit } from "@intentic/base/git";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { isolatedAgent } from "./registry/agents-store.testing.js";
import { guestReach } from "../auth/role-floor.js";
import type { PersistedAgent } from "./registry/agents-store.js";
import { createProducedFileRoute, includeProducedFiles } from "./produced-files.js";

// A conversation's recorded results as bytes (produced-files.ts): who may take them, which paths count, and which copy
// of the file answers before and after its work is accepted. On disk, since links and missing checkouts are the point.

let root: string;
let main: string;
let copy: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-results-"));
    main = join(root, "main");
    copy = join(root, "copy");
    await mkdir(main);
    await mkdir(copy);
    await writeFile(join(copy, "report.odt"), "conversation result");
    await writeFile(join(main, "report.odt"), "someone else's file");
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const guest = "guest@example.test";
const started = (agent: PersistedAgent): PersistedAgent => ({ ...agent, identity: { ...agent.identity, startedBy: guest } });
const entry = started(isolatedAgent([{ repo: "root", base: "aaaaaaa" }]));
const rows: TranscriptRow[] = [
    { role: "assistant", text: "Done", tools: [{ id: "write", name: "Bash", category: "execute", status: "completed", locations: [{ path: "report.odt" }] }] },
];
const deps = (agent: PersistedAgent) => ({
    agents: unstubbed<Services["agents"]>("agents", { entry: (id) => (id === agent.id ? agent : undefined) }),
    transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => rows }),
    workspaceScope: { main, entry: () => agent, worktreeDir: () => copy },
});
const app = ({ email = guest, role = "guest", agent = entry }: { email?: string; role?: MemberRole; agent?: PersistedAgent } = {}) => {
    const hono = new Hono<AppEnv>();
    hono.use("*", async (c, next) => {
        c.set("identity", { email, role, methods: [] });
        await next();
    });
    hono.get("/agents/:id/documents/raw", createProducedFileRoute(deps(agent)));
    return hono;
};
const url = (path: string) => `/agents/${entry.id}/documents/raw?${new URLSearchParams({ path })}`;

const git = (dir: string, ...args: string[]) => defaultGit(dir, ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args]);

// The main tree as a repo whose last commit holds the accepted report, and the conversation as having landed it there.
const acceptedInMain = async (): Promise<PersistedAgent> => {
    await git(main, "init", "-q");
    await writeFile(join(main, "report.odt"), "accepted result");
    await git(main, "add", "report.odt");
    await git(main, "commit", "-q", "-m", "accepted");
    const tip = (await git(main, "rev-parse", "HEAD")).stdout.trim();
    return started(isolatedAgent([{ repo: "root", base: tip, landedTip: tip, landedHead: tip }]));
};

test("own recorded result is on the guest allowlist and serves the conversation's own copy", async () => {
    expect(guestReach("GET", `/agents/${entry.id}/documents/raw`)).toBe(true);
    const response = await app().request(url("report.odt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("conversation result");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''report.odt");
});

test("another guest cannot fetch the file", async () => {
    expect((await app({ email: "other@example.test" }).request(url("report.odt"))).status).toBe(403);
});

test("a guest who started the conversation loses its files once it is handed to someone else", async () => {
    const handed: PersistedAgent = { ...entry, social: { ...entry.social, owner: { email: "clerk@example.test", since: 1 } } };
    expect((await app({ agent: handed }).request(url("report.odt"))).status).toBe(403);
});

test("a member who may see the conversation downloads its results like its starter", async () => {
    const response = await app({ email: "owner@example.test", role: "owner" }).request(url("report.odt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("conversation result");
});

test.each(["unlisted.odt", "../main/report.odt", "/report.odt", "folder/../report.odt", "./report.odt"])("unlisted or traversal path %s is refused", async (path) => {
    expect((await app().request(url(path))).status).toBe(403);
});

test("a listed symlink is refused", async () => {
    await rm(join(copy, "report.odt"));
    await writeFile(join(root, "private.odt"), "private");
    await symlink(join(root, "private.odt"), join(copy, "report.odt"));
    expect((await app().request(url("report.odt"))).status).toBe(404);
});

test("before its work is accepted, a result the checkout lacks is not read from the main tree", async () => {
    await rm(join(copy, "report.odt"));
    expect((await app().request(url("report.odt"))).status).toBe(404);
});

test("after a land carried it, the accepted file stays downloadable once the checkout is removed", async () => {
    const landed = await acceptedInMain();
    await rm(copy, { recursive: true });
    const response = await app({ agent: landed }).request(url("report.odt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("accepted result");
});

test("a land that did not carry the file never opens the main tree's file of that name", async () => {
    const landed = await acceptedInMain();
    await git(main, "rm", "-q", "--cached", "report.odt");
    await git(main, "commit", "-q", "-m", "untrack");
    const tip = (await git(main, "rev-parse", "HEAD")).stdout.trim();
    const other: PersistedAgent = { ...landed, placement: { kind: "worktree", branch: "agent/c1", repos: [{ repo: "root", base: tip, landedTip: tip }] } };
    await rm(copy, { recursive: true });
    expect((await app({ agent: other }).request(url("report.odt"))).status).toBe(404);
});

test("including results stages an ignored document and leaves unrelated ignored files alone", async () => {
    await defaultGit(copy, ["init"]);
    await writeFile(join(copy, ".gitignore"), "*.odt\n");
    await writeFile(join(copy, "unrelated.odt"), "not a result");
    await includeProducedFiles(
        { transcripts: deps(entry).transcripts, agentWorktrees: unstubbed<Services["agentWorktrees"]>("worktrees", { worktreeDir: () => copy }) },
        isolatedAgent([{ repo: "root", base: "aaaaaaa" }]),
    );
    expect((await defaultGit(copy, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("report.odt");
});
