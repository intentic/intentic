import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../app.js";
import { grantsOf } from "../auth/grants.js";
import type { ControlTokens } from "../auth/tokens/control-tokens.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { deployGrantsDocument, fileDeployGrants } from "./deploy-grants.js";
import { deployFixture, stackRepo } from "./deploys.testing.js";

// The owner's grants (deploy-grants.ts): kept by repository, stack and computer in the auth root, refused rather than read
// as empty when the file cannot be read, given and taken back over the routes by a person, and out of every agent's reach.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-grants-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-grants-auth-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

test("a grant is one per repository, stack and computer: granting again replaces it, and revoking takes every computer's", async () => {
    const grants = fileDeployGrants(join(state, deployGrantsDocument.path));
    const at = "2026-11-25T12:00:00.000Z";
    await grants.set({ repo: "shop", stack: "web", device: "rog", secrets: ["A"], grantedAt: at });
    await grants.set({ repo: "shop", stack: "web", device: "z440", secrets: ["A"], grantedAt: at });
    await grants.set({ repo: "shop", stack: "web", device: "rog", secrets: ["A", "B"], grantedAt: at });
    await grants.set({ repo: "shop", stack: "api", device: "rog", secrets: ["C"], grantedAt: at });
    expect(await grants.forStack("shop", "web", "rog")).toEqual({ repo: "shop", stack: "web", device: "rog", secrets: ["A", "B"], grantedAt: at });
    // Moved to another computer, a stack asks again.
    expect(await grants.forStack("shop", "web", "omen")).toBeUndefined();
    expect(await grants.revoke("shop", "web")).toBe(2);
    expect(await grants.revoke("shop", "web")).toBe(0);
    expect((await grants.list()).map((grant) => `${grant.stack}@${grant.device}`)).toEqual(["api@rog"]);
});

test("a grants file this build cannot read is never read as nothing granted, and nothing is written over it", async () => {
    const path = join(state, deployGrantsDocument.path);
    await writeFile(path, "{ not json");
    const grants = fileDeployGrants(path);
    await expect(grants.list()).rejects.toThrow(`the deploy grants at ${path} could not be read`);
    await expect(grants.set({ repo: "shop", stack: "web", device: "rog", secrets: [], grantedAt: "2026-11-25T12:00:00.000Z" })).rejects.toThrow("could not be read by this build");
});

test("the agent token reaches the reads, the deploys and the ask for a grant, and never the grant or its revoking", async () => {
    const agent = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: unstubbed<ControlTokens>("controlTokens", {}),
        verifySync: async () => ({ kind: "enrolled", id: "laptop", card: "laptop" }),
        verifyExtension: () => undefined,
    }).find((grant) => grant.header === "x-intentic-agent");
    const reaches = async (method: string, path: string): Promise<string | undefined> => (await agent?.authorize("agent", method, path))?.verdict;
    expect({
        environments: await reaches("GET", "/deploys/environments"),
        history: await reaches("GET", "/deploys/history"),
        deploy: await reaches("POST", "/deploys/deploy"),
        rollback: await reaches("POST", "/deploys/rollback"),
        promote: await reaches("POST", "/deploys/promote"),
        request: await reaches("POST", "/deploys/grants/request"),
        grant: await reaches("POST", "/deploys/grants/grant"),
        revoke: await reaches("POST", "/deploys/grants/revoke"),
    }).toEqual({
        environments: "ok",
        history: "ok",
        deploy: "ok",
        rollback: "ok",
        promote: "ok",
        request: "ok",
        grant: "out-of-scope",
        revoke: "out-of-scope",
    });
});

test("the owner grants a stack exactly the names its manifest reads at HEAD, and takes the grant back, over the routes", async () => {
    await stackRepo(root, "shop", [{ name: "web", device: "rog", env: { A: "{{secret:API_TOKEN}}", B: "{{secret:DB_URL}}" } }]);
    const { engine } = deployFixture(root, state);
    const client = clientFor(createApp(services({ deploys: engine })));

    const { grants } = await client.deploys.grant({ repo: "shop", stack: "web" });

    expect(grants).toEqual([{ repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], grantedAt: expect.any(String) }]);
    expect(await client.deploys.grants()).toEqual({ grants });
    expect(await client.deploys.revoke({ repo: "shop", stack: "web" })).toEqual({ ok: true });
    expect(await errorCode(client.deploys.revoke({ repo: "shop", stack: "web" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.deploys.grant({ repo: "shop", stack: "api" }))).toBe("NOT_FOUND");
});
