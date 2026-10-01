import { t } from "@intentic/ui/i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { watch } from "vue";
import { pending, setupMode } from "./setup";

// THE MAIN WINDOW'S OS TITLE WHILE A SETUP OWNS IT. The title is the taskbar's and alt-tab's label, and the one thing
// outside the process that can tell a window running a setup from one showing a folder: the desktop smoke tiers read it
// (_tools/desktop-smoke-windows/src/constants.ts SETUP_TITLE, _tools/desktop-smoke/smoke.sh). The launcher said it
// before This device took its place. The app names the window after its folder (local.rs); that title is read before
// the setup takes it, and handed back once the setup does.

/** What the window is called while a setup for `name` (or an unnamed sandbox) owns it. */
export const setupTitle = (name: string | undefined): string => `${t(`desktop.app.settingUp`)} ${name ?? t(`desktop.app.sandbox`)} · Intentic`;

/** Keep the main window's title on the setup while one is up, and give the folder its title back after. Once. */
export const titleTheSetup = (): void => {
    const window = getCurrentWindow();
    // The folder's title, while the setup wears the window's; undefined while it doesn't.
    let folderTitle: Promise<string> | undefined;
    watch(
        [setupMode, () => pending.value?.name],
        ([open, name]) => {
            if (open) {
                folderTitle ??= window.title();
                void folderTitle.then(() => window.setTitle(setupTitle(name))).catch(ignore);
            } else if (folderTitle !== undefined) {
                const back = folderTitle;
                folderTitle = undefined;
                void back.then((title) => window.setTitle(title)).catch(ignore);
            }
        },
        { immediate: true },
    );
};

// allow(silent-catch): a title the platform refused leaves the one it had, which is all a failure here costs.
const ignore = (): undefined => undefined;
