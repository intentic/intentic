import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { fileDoorTokens } from "../auth/tokens/door-tokens.js";
import type { Services } from "../composition.js";
import { createWorkflowsRoutes } from "./workflows.routes.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows-store.js";

// A door file this build cannot read is refused rather than re-minted (auth/tokens/door-tokens.ts). An operator's list
// still loads, the gated row without its URL as a viewer sees it, and a save or rotation that needs the file answers
// CONFLICT naming it.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/workflows" };

const gated: Workflow = {
    id: "release",
    name: "release gate",
    maxParallel: 1,
    gate: { step: "judge", field: "release", pass: ["pass"] },
    steps: [
        {
            id: "judge",
            title: "Judge",
            goal: "a release decision exists",
            prompt: "decide whether this ships",
            needs: [],
            handoff: "fresh",
            output: { kind: "json", fields: [{ name: "release", type: "string", description: "pass | fail", required: true }] },
            checks: [],
            context: "fresh",
        },
    ],
};

test("a door file that cannot be read costs a gated row its URL, not the list, and a save answers CONFLICT", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-routes-"));
    const doorsPath = join(root, "doors.json");
    const services = unstubbed<Services>("services", {
        auth: undefined,
        workflows: fileWorkflowsStore(join(root, "workflows.json")),
        workflowRuns: fileWorkflowRunsStore(join(root, "workflow-runs.json")),
        doorTokens: fileDoorTokens(doorsPath),
    });
    const routes = createWorkflowsRoutes(services);
    expect((await call(routes.save, { workflow: gated, create: true }, { context })).gateToken).toEqual(expect.any(String));
    writeFileSync(doorsPath, "{ this is not json");

    const listed = await call(routes.list, undefined, { context });
    expect(listed.workflows.map((row) => [row.id, row.gateToken])).toEqual([["release", undefined]]);

    await expect(call(routes.save, { workflow: gated, create: false }, { context })).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("doors.json could not be read by this build"),
    });
    await expect(call(routes.rotateGateToken, { id: "release" }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
});
