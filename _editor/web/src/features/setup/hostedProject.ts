import type { SandboxSummary } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { desktopSyncLink } from "../../app/environments/desktop";
import type { SyncPairing } from "../sandbox/devices/sync/useDesktopSync";
import type { SetupProject } from "./setupArrival";

/* A HOSTED PROJECT'S FOLDER GOES TO THE APP BEFORE ITS WORKSPACE OPENS. The desktop app parked the folder when it opened
 * this page, and a machine of ours cannot reach this computer: so once the machine answers, this page mints a sync
 * pairing on it, as the Desktop sync card does, and hands it to the app in a sync link naming the project and the
 * sandbox. The app binds that link to the folder it parked (never to a path on the link), copies the folder into
 * `/work/<project>` and remembers which sandbox it went to. Only inside the app: nothing else hears a sync link. A
 * hand-over that fails keeps the page, saying so, and the registry watch's next reading tries again; a sandbox on this
 * computer, or a setup that is not a project's, has nothing to hand over. */

export interface ProjectHandoffHost {
    // The folder this setup is for, if any (`?project=`).
    readonly project: SetupProject | undefined;
    // Inside the desktop app, the one place a sync link is heard from (setup_link.rs).
    readonly inApp: () => boolean;
    // The row as the registry last listed it: its address is the one the Desktop sync card enrolls with.
    readonly sandboxOf: (id: string) => SandboxSummary | undefined;
    // A sync pairing minted on the selected sandbox (useDesktopSync.ts `mintSyncPairing`).
    readonly mint: () => Promise<SyncPairing>;
    readonly open: (link: string) => void;
}

export const useProjectHandoff = ({ project, inApp, sandboxOf, mint, open }: ProjectHandoffHost) => {
    // Why the last hand-over failed, on the wait card until one takes.
    const refusal = ref<NoticeModel | undefined>(undefined);

    const refuse = (notice: NoticeModel): boolean => {
        refusal.value = notice;
        return false;
    };

    // Hands the folder over for the sandbox that just reported in; false while it could not be, which keeps this page.
    const handOff = async (id: string): Promise<boolean> => {
        const sandbox = sandboxOf(id);
        if (project === undefined || !inApp() || sandbox === undefined || (sandbox.hosted ?? null) === null) {
            return true;
        }
        const failed = t(`setup.setup.folderNotHandedToApp`);
        // No address to enroll with, which a sandbox that reported in has had since it did.
        if (sandbox.daemonUrl === null) {
            return refuse(noticeOf(failed, { tone: `warning` }));
        }
        try {
            const pairing = await mint();
            // A pairing that syncs no folder (what a member's comes back as) has nothing to copy one with.
            if (pairing.mode !== `sync`) {
                return refuse(noticeOf(failed, { tone: `warning` }));
            }
            open(desktopSyncLink({ url: sandbox.daemonUrl, pair: pairing.token, name: sandbox.name, sandbox: sandbox.id, project: project.dirName }));
            refusal.value = undefined;
            return true;
        } catch (err) {
            return refuse(noticeFrom(err, failed, { tone: `warning` }));
        }
    };

    return { refusal, handOff };
};
