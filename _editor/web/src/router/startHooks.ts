import { useDevice } from "@intentic/ui";
import type { Router } from "vue-router";
import { finishBoot, markBoot } from "../app/perf/boot";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { warmView } from "../components/asyncView";
import { loadShellDesktop, loadShellMobile, loadWorkspaceShell } from "../shell/shellChunks";

// The start's two router hooks, installed by main.ts before the first navigation.
export const installStartHooks = (router: Router): void => {
    // THE SHELL'S CHUNKS ARE ASKED FOR WHILE THE GUARDS RUN. A route's components load only once its guards have passed,
    // and the shell then asks for its form factor's chrome, which then asks for the view: three round trips one after
    // another, after the session, the cache restore and the sandbox list had already been waited on. Asked for here, by
    // a global hook (every one of which runs before a route's own guards), they arrive alongside the guards' answers; a
    // dynamic import of the same file shares one fetch, so what lands here is what the route, the shell and asyncView
    // then find. Only on a browser that had a sandbox open (the account's key, gone at sign-out), so a signed-out visit
    // headed for the sign-in page downloads nothing it won't show.
    router.beforeEach((to) => {
        if (activeSandboxId.value !== undefined && to.matched.some((match) => match.path === `/`)) {
            // allow(silent-catch): a chunk that fails here fails again where it is used, which owns the recovery (loadChunk).
            loadWorkspaceShell().catch(() => undefined);
            const chrome = useDevice().mobile.value ? loadShellMobile() : loadShellDesktop();
            // allow(silent-catch): as above.
            chrome.catch(() => undefined);
            for (const match of to.matched) {
                const view = match.components?.[`default`];
                if (view !== undefined) {
                    warmView(view);
                }
            }
        }
        return true;
    });

    // The start's last router link (app/perf/boot.ts): the first navigation has landed, its guards passed and its
    // route-level chunks loaded. A page outside the shell has drawn by then; one inside it is filed by the view it shows
    // (asyncView).
    router.afterEach((to, _from, failure) => {
        if (failure !== undefined) {
            return;
        }
        markBoot(`guards`);
        if (!to.matched.some((match) => match.path === `/`)) {
            finishBoot(String(to.name ?? to.path));
        }
    });
};
