import { useDevice } from "@intentic/ui";
import { computed } from "vue";
import { desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { environment } from "../../../app/environments/environment";
import { scriptSource } from "../../../app/environments/scriptCommand";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { apiClient } from "../../../lib/useApi";
import { markJustSetUp } from "../../../models/sandbox/live/justSetUp";
import { useDesktopSetup } from "../desktopSetup";
import { platformUrlOf } from "../flow/installCommand";
import { useAddSandbox } from "./useAddSandbox";

// THE ADD SANDBOX RUN AS THIS WINDOW STARTS IT: the platform, this computer's app, the connected machines and the
// browser's own credential, wired once for the two places that draw it. Home's new sandbox (features/home/newSandbox/)
// on a desktop, and the dialog (AddSandboxDialog.vue) on a phone or in a guest's window, which has no Home to stand on.

export interface AddSandboxHereOptions {
    /**
     * Whether this page draws the app's install itself, so the app runs it out of sight instead of swapping This device
     * in over the page (desktop.ts `DesktopSetupArgs.stay`). Home does; the dialog leaves the app its card.
     */
    readonly appStays: boolean;
    /**
     * Whether the row, once it reports in, becomes the active sandbox. The dialog's always does; Home's only while the
     * reader is watching it, since a reader who went back to another sandbox's chat must not be pulled off it.
     */
    readonly selects: () => boolean;
    /** The row reported in, and was selected when `selects` said so. */
    readonly reportedIn: (sandboxId: string) => void;
}

export const useAddSandboxHere = (options: AddSandboxHereOptions) => {
    const sandbox = useSandbox();
    const { mobile } = useDevice();
    const { getIdToken, warmIdToken } = useGoogleIdentity();
    const platformUrl = platformUrlOf(environment.api.url);

    const add = useAddSandbox({
        sandbox: {
            ...sandbox,
            select: (id) => {
                if (options.selects()) {
                    sandbox.select(id);
                }
            },
        },
        platform: apiClient.sandbox,
        inApp: () => desktopVersion() !== undefined,
        machines: () => true,
        buildsFromCheckout: platformUrl !== undefined && scriptSource.value === `checkout`,
        platformUrl,
        appStays: options.appStays,
        mobile,
        openDesktopLink,
        warmCredential: async () => {
            await warmIdToken();
            if ((await getIdToken({ interactive: false })) === undefined) {
                await getIdToken({ silent: true });
            }
        },
        enter: async () => {
            const id = add.created.value?.id;
            if (id === undefined) {
                return;
            }
            // The workspace's first quiet seconds are a connection on its way, not a setup left unfinished (justSetUp.ts).
            markJustSetUp(id);
            options.reportedIn(id);
        },
    });

    const desktop = useDesktopSetup();
    // The app's report, while it is about this sandbox: its module state may still hold an earlier install's last word.
    const desktopReport = computed(() => {
        const report = desktop.report.value;
        return report !== undefined && (report.name === undefined || report.name === add.created.value?.name) ? report : undefined;
    });

    return { add, desktop, desktopReport };
};

export type AddSandboxHere = ReturnType<typeof useAddSandboxHere>;
