import { safetyContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { stateRelPath } from "../state-paths.js";

/* The Safety page's two reads and its one write: the policy document, and the log of what it decided. */
// The write is the Agent tab's own, so it is committed as it lands (settings-versions.ts): left uncommitted, a land
// touching the policy was refused as the owner's edits. Not over edits already in it, which may be the owner's by hand.
export const createSafetyRoutes = (services: Pick<Services, "safetyPolicy" | "safetyLog" | "agentWorktrees" | "logger">) => {
    const i = implement(safetyContract).$context<OrpcContext>();
    return {
        policy: i.policy.handler(() => services.safetyPolicy.get()),
        setPolicy: i.setPolicy.handler(async ({ input }) => {
            await versionedSettingsWrite(services, [stateRelPath(".intentic/config/safety.md")], "Settings: safety policy", () =>
                services.safetyPolicy.set(input.text),
            );
            return { ok: true } as const;
        }),
        log: i.log.handler(() => services.safetyLog.recent()),
    };
};
