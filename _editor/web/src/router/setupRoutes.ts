import { t } from "@intentic/ui/i18n";
import type { RouteRecordRaw } from "vue-router";
import { asyncView } from "../components/asyncView";
import { requireAuth } from "./sessionGuard";

// Account-scoped setup pages outside the workspace shell. Hosted entry reads the cloud options before creating;
// setup continues the selected machine's provisioning.
export const setupRoutes: RouteRecordRaw[] = [
    {
        path: `/start/hosted`,
        name: `hosted-start`,
        meta: { title: () => t(`hostedStart.title`) },
        beforeEnter: [requireAuth],
        component: () => import(`../features/setup/hosted/HostedStart.vue`),
    },
    {
        // Initial-setup / recovery view. Outside the shell; signed-in but bounced back to the workspace once the
        // sandbox is connected (redirectIfReady).
        path: `/setup`,
        name: `setup`,
        meta: { title: () => t(`router.index.setup`) },
        beforeEnter: [requireAuth],
        // Wrapped although it is outside the shell: "Add sandbox" reaches it from the shell, and that click deserves
        // the same instant flip as any other. Full-screen wizard, so no outline to promise.
        component: asyncView(() => import(`../features/setup/Setup.vue`)),
    },
];
