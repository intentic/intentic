import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../composition.js";
import { rootExecution } from "../../workload/agent-execution.testing.js";
import { RoleModelUnsetError } from "../../seams/role-model-unset.js";
import { summaryNote } from "./limit-handoff.js";

// An unset summary role fails before a provider is asked; the reason must still reach the hand-off notice.
test("a failed hand-off summary exposes its fallback reason", async () => {
    const services = unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ modelSetups: [], roleSetups: {} }),
        }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
    });
    const lease = rootExecution({ localCwd: WORKSPACE_ROOT });
    try {
        expect(await summaryNote(services, lease.context, {
            conversationId: "summary-cut", rows: [{ role: "user", text: "fix it" }], contextTokens: 300_000,
            signal: new AbortController().signal, spentProvider: "claude",
        })).toEqual({ event: { mode: "summary", fellBack: true, reason: new RoleModelUnsetError("handoff-summary").message } });
    } finally {
        lease.release();
    }
});
