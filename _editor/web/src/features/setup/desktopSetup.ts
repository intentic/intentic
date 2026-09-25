import { readonly, ref, type Ref } from "vue";
import { DESKTOP_SETUP_EVENT, readDesktopSetupReport, type DesktopSetupReport } from "../../app/environments/desktop";

/* The setup page remains available while setup runs in the background. */
// allow(module-state): the desktop app's own setup report
const report = ref<DesktopSetupReport | undefined>(undefined);
// allow(module-state): when that report was last heard
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
