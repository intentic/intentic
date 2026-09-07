import { readonly, ref, type Ref } from "vue";
import { DESKTOP_SETUP_EVENT, readDesktopSetupReport, type DesktopSetupReport } from "../../app/environments/desktop";

/* THE INSTALL THE DESKTOP APP IS RUNNING, AS THIS PAGE LAST HEARD OF IT.
 *
 * The app's setup card can be stepped aside ("Back to your workspace") while its run keeps going, and the
 * page the user then lands on is this one, the setup page, which until now could only say "follow it in the
 * Intentic window" about a window that had just left. The app announces every change of its own bar into
 * this webview (environments/desktop.ts `DESKTOP_SETUP_EVENT`); this holds the last one, for the strip the
 * page draws beside its wait line (DesktopSetupProgress.vue).
 *
 * Module state rather than component state because the event arrives whether or not the page is mounted,
 * and a page that mounts after the last tick must still show it: the app reports every second while a run is
 * live, so the gap is never long, but a run that has STOPPED reports once and then falls silent, and that
 * one report is exactly the one a page must not miss. `heardAt` is for the strip's own staleness reading: a
 * run that says "running" and has said nothing for a while is an app that went away. */
const report = ref<DesktopSetupReport | undefined>(undefined);
const heardAt = ref<number | undefined>(undefined);
let listening = false;

export const useDesktopSetup = (): { readonly report: Readonly<Ref<DesktopSetupReport | undefined>>; readonly heardAt: Readonly<Ref<number | undefined>> } => {
    if (!listening) {
        listening = true;
        window.addEventListener(DESKTOP_SETUP_EVENT, (event) => {
            const next = readDesktopSetupReport((event as CustomEvent<unknown>).detail);
            if (next === undefined) {
                return;
            }
            heardAt.value = Date.now();
            // The card was put away: nothing left to draw, and nothing to be stale about.
            report.value = next.state === `closed` ? undefined : next;
        });
    }
    return { report: readonly(report), heardAt: readonly(heardAt) };
};
