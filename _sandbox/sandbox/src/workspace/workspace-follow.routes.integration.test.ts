import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../conversations/registry/agents-store.testing.js";
import { errorCode, proven } from "../harness/route-client.testing.js";
import { memoryAreasStore } from "../harness/route-stores.testing.js";
import { createLogger } from "../logger.js";
import { checkoutFollow, closeCheckoutFollow, FOLLOW_LEASE_MS } from "./watch/checkout-follow.js";
import { createWorkspaceFollowRoutes } from "./workspace-follow.routes.js";

// Who may follow files in a conversation's own copy, and what is watched for them: the same two questions a read of
// that copy asks (may this caller see the conversation, does their fence reach the path), the shared tree left to its
// own watcher, and a path that climbs out never reaching a watch. Driven through the handler with the context the
// middleware hands on, over real folders, since whether a folder is there decides what is watched.

let base: string;
let worktrees: string;

const routesOver = (entries: readonly PersistedAgent[]) => {
    const main = join(base, "work");
    return createWorkspaceFollowRoutes(
        unstubbed<Pick<Services, "areas" | "agents" | "workspaceScope" | "logger">>("services", {
            areas: memoryAreasStore([{ id: "support", folders: ["support"] }]),
            agents: unstubbed<Services["agents"]>("agents", { entry: (id) => entries.find((entry) => entry.id === id) }),
            workspaceScope: unstubbed<Services["workspaceScope"]>("workspaceScope", {
                main,
                entry: (id) => entries.find((entry) => entry.id === id),
                worktreeDir: (id) => join(worktrees, id),
            }),
            logger: createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" }),
        }),
    );
};

// The owner's own tools carry no member identity; everyone else arrives as the member the bearer proved.
const owner: OrpcContext = { headers: new Headers(), method: "POST", url: "/workspace/follow-checkout" };
const as = (identity: NonNullable<OrpcContext["identity"]>): OrpcContext => ({ ...owner, identity });

beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "follow-routes-"));
    worktrees = join(base, "worktrees");
    await mkdir(join(base, "work"), { recursive: true });
    await mkdir(join(worktrees, "c-1", "docs"), { recursive: true });
    await mkdir(join(worktrees, "c-1", "support"), { recursive: true });
});

afterEach(async () => {
    closeCheckoutFollow();
    await rm(base, { recursive: true, force: true });
});

test("the folders of a conversation's own files are watched for one lease", async () => {
    const routes = routesOver([isolatedAgent([], { id: "c-1" })]);
    expect(await call(routes.followCheckout, { agent: "c-1", paths: ["docs/report.md", "README.md", "docs/notes.md"] }, { context: owner })).toEqual({
        leaseMs: FOLLOW_LEASE_MS,
    });
    // `docs` once for its two files, and the checkout's own root.
    expect(checkoutFollow().watched()).toBe(2);
});

test("a conversation on the shared tree is answered without a watch: the shared watcher covers it", async () => {
    const routes = routesOver([conversationEntry({ id: "c-2" })]);
    expect(await call(routes.followCheckout, { agent: "c-2", paths: ["docs/report.md"] }, { context: owner })).toEqual({ leaseMs: FOLLOW_LEASE_MS });
    expect(checkoutFollow().watched()).toBe(0);
});

test("a caller who may not see the conversation may not follow its files, and an unknown one is not found", async () => {
    const routes = routesOver([isolatedAgent([], { id: "c-1", identity: { startedBy: "ada@example.com" } })]);
    expect(await errorCode(call(routes.followCheckout, { agent: "c-1", paths: ["docs/a.md"] }, { context: as(proven("dee@example.com", "guest")) }))).toBe(
        "FORBIDDEN",
    );
    expect(await errorCode(call(routes.followCheckout, { agent: "c-9", paths: ["docs/a.md"] }, { context: owner }))).toBe("NOT_FOUND");
    expect(checkoutFollow().watched()).toBe(0);
});

test("paths outside the caller's fence, or climbing out of the copy, are left out", async () => {
    const routes = routesOver([isolatedAgent([], { id: "c-1", identity: { areas: ["support"] } })]);
    const fenced = as(proven("fay@example.com", "collaborator", ["google"], ["support"]));
    await call(routes.followCheckout, { agent: "c-1", paths: ["docs/a.md", "support/b.md", "../../etc/passwd"] }, { context: fenced });
    expect(checkoutFollow().watched()).toBe(1);
});
