import type { RouteRecordRaw } from "vue-router";
import { t } from "@intentic/ui/i18n";
import { NO_SANDBOX_PATH } from "../app/environments/standAside";
import { requireAuth } from "./sessionGuard";

// The rule that puts the app's reader on This computer instead of a blank setup lives in app/environments/standAside.ts,
// below the features that leave for setup themselves (a removal of the last sandbox, recovery finding nothing); this is
// the page the workspace waits on behind it.
export { createStandAside, NO_SANDBOX_PATH, type StandAside, type StandAsideHost, workspaceAside } from "../app/environments/standAside";

// Outside the shell, as setup is; signed in, since it speaks of the account.
export const noSandboxRoute: RouteRecordRaw = {
    path: NO_SANDBOX_PATH,
    name: `no-sandbox`,
    meta: { title: () => t(`setup.noSandbox.title`) },
    beforeEnter: [requireAuth],
    component: () => import(`../features/setup/NoSandbox.vue`),
};
