import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../../../composition.js";
import { rootExecution } from "../../../../workload/agent-execution.testing.js";
import { RoleModelUnsetError } from "../../../../seams/role-model-unset.js";
import { continuationOf } from "./turn-continuation.js";

test("a summary continuation carries the summary's fallback reason into its hand-off", async () => {
    const services = unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ modelSetups: [], roleSetups: {} }),
        }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
    });
    const lease = rootExecution({ localCwd: WORKSPACE_ROOT });
    try {
        expect(await continuationOf(services, lease.context, {
            input: { agent: "claude", harness: "claude-code", conversationId: "summary-cut", prompt: "fix it" },
            history: [{ role: "user", text: "fix it" }],
            localCwd: WORKSPACE_ROOT,
            held: undefined,
            way: "summary",
            rollover: undefined,
            resumed: undefined,
            delivery: { event: undefined, stamps: {} },
            signal: new AbortController().signal,
        })).toEqual({
            notes: [],
            handedOff: { mode: "summary", fellBack: true, reason: new RoleModelUnsetError("handoff-summary").message },
            freshStart: undefined,
            stamps: {},
        });
    } finally {
        lease.release();
    }
});
