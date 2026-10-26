import { t } from "@intentic/ui/i18n";
import type { RouteLocationRaw, RouteRecordRaw } from "vue-router";
import { localFace } from "../app/environments/local";
import { localHost } from "../app/environments/localHost";
import { useAccount } from "../client/auth/useAccount";
import { asyncView } from "../components/asyncView";
import { SANDBOX_SETUP_PATH } from "../local/setup/setupPath";
import { LOCAL_PROCESS_PATH } from "../models/processes/processAddress";
import { LOCAL_ADD_SANDBOX_PATH } from "../models/sandbox/addSandbox";
import { hubOutline, settingsPartRoutes } from "./routeParts";
import { requireAuth } from "./sessionGuard";
import { requireSetup } from "./shellGates";

// The account's Settings in a desktop window on a folder: only while there is an account (useAccount.ts), since every
// section but the look is about one. Waits on one ask of the platform at most, which the app gives up on in seconds.
const requireAccount = async (): Promise<true | RouteLocationRaw> => {
    const account = useAccount();
    await account.settled();
    return account.user.value === null ? `/workspace` : true;
};

// A DESKTOP WINDOW ON A FOLDER OF THIS COMPUTER (app/environments/local.ts) has a shell of its own, not a sandbox's: the
// same rail, holding what needs no sandbox (local/LocalShell.vue). Files is the folder; every other tile is a view the app
// adds (localHost.ts), This device first; the account's Settings open from the rail's foot, as in the sandbox shell.
// Guarded like the sandbox shell: the window's bootstrap seeds what both guards read, so neither waits on a server.
// Anything else leads back to the folder, since every other screen reads a sandbox.
export const localRoutes = (): RouteRecordRaw[] => [
    {
        path: `/`,
        beforeEnter: [requireAuth, requireSetup],
        component: () => import(`../local/LocalShell.vue`),
        children: [
            { path: ``, redirect: `/workspace` },
            {
                // The folder's tree and its documents. The path is the tree's, not the window's: the window is one folder.
                path: `workspace/:path(.*)*`,
                name: `workspace`,
                meta: { title: () => localFace()?.name ?? t(`shared.files`) },
                component: asyncView(() => import(`../local/LocalFiles.vue`)),
            },
            // The folder's way to a sandbox of its own (local/setup/LocalSandboxSetup.vue): its tile is on the rail while the
            // folder is on its way (LocalShell.vue), and "Work on this with an agent" in Files opens it.
            ...(localHost().project === undefined
                ? []
                : [
                      {
                          path: SANDBOX_SETUP_PATH.slice(1),
                          name: `local-sandbox-setup`,
                          meta: { title: () => t(`local.sandboxSetup.tile`, { name: localFace()?.name ?? `` }) },
                          component: asyncView(() => import(`../local/setup/LocalSandboxSetup.vue`)),
                      } satisfies RouteRecordRaw,
                  ]),
            // Repair, the agent that runs on this computer outside every sandbox: its tile is on the rail while it is open or at work (LocalShell.vue). (This PC's
            // own first-run setup is the app's This computer view since 2026-10-12, not a route of the shell's.)
            ...(localHost().repair === undefined
                ? []
                : [
                      {
                          path: `repair`,
                          name: `local-repair`,
                          meta: { title: () => t(`local.repair.title`) },
                          component: asyncView(() => import(`../local/repair/LocalRepair.vue`)),
                      } satisfies RouteRecordRaw,
                  ]),
            // A process's page (local/process/LocalProcess.vue), opened from its tile in the rail's group of processes under
            // way, the same page Home draws in the chat's place.
            ...(localHost().processes === undefined
                ? []
                : [
                      {
                          path: `${LOCAL_PROCESS_PATH.slice(1)}/:id`,
                          name: `local-process`,
                          props: true,
                          meta: { title: () => t(`processes.group`) },
                          component: asyncView(() => import(`../local/process/LocalProcess.vue`)),
                      } satisfies RouteRecordRaw,
                  ]),
            // A new sandbox made from this window (local/newSandbox/LocalNewSandbox.vue): Devices' "Set one up" and the
            // switcher's "Add a sandbox", made here rather than in the workspace.
            ...(localHost().newSandbox === undefined
                ? []
                : [
                      {
                          path: LOCAL_ADD_SANDBOX_PATH.slice(1),
                          name: `local-new-sandbox`,
                          meta: { title: () => t(`sandbox.words.addSandbox`) },
                          component: asyncView(() => import(`../local/newSandbox/LocalNewSandbox.vue`)),
                      } satisfies RouteRecordRaw,
                  ]),
            ...localHost().views.map(
                (view): RouteRecordRaw => ({
                    path: view.path,
                    name: view.path,
                    meta: { title: view.title },
                    component: asyncView(view.load),
                }),
            ),
            ...settingsPartRoutes(),
            {
                path: `settings/:tab?`,
                name: `settings`,
                meta: { title: () => t(`shared.settings`) },
                beforeEnter: requireAccount,
                component: asyncView(() => import(`../features/settings/SettingsHub.vue`), hubOutline(() => t(`shared.settings`), () => ``, 5)),
            },
        ],
    },
    { path: `/:pathMatch(.*)*`, redirect: `/workspace` },
];
