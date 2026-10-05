import { t } from "@intentic/ui/i18n";
import type { LocalFace } from "@intentic/web/local";
import type { LocalHost, LocalProjectHost, LocalProjectStart, LocalView } from "@intentic/web/local-host";
import { computed } from "vue";
import { readAccount, signOutAccount, updateAccount } from "./account";
import {
    foundOnMachine,
    homeFacts,
    localForgetRecent,
    localOpenPath,
    localPick,
    localPoint,
    localRecents,
    localRoster,
    projectCreate,
    projectPreview,
    signIn,
    workspaceOpen,
    type ProjectCreated,
} from "./desktop";
import { deviceBadge } from "./device/badge";
import { projectBuildOf, projectPathOf } from "./device/projectBuild";
import { useDevice } from "./device/useDevice";

// THE APP'S HALF OF A LOCAL WINDOW'S SHELL (the web's app/environments/localHost.ts): what the editor asks of this
// computer, answered by the app's own commands, the account the workspace signed in with (account.ts), and the view the
// app adds to the rail, This device. Installed on the
// window by the local face's bootstrap (local/main.ts) before the editor's modules run, so the router finds the view
// when it builds its routes.
//
// Every verb is a Tauri command the local windows' capability names (src-tauri/capabilities/local.json). A command's
// refusal is a sentence already written for the reader (local.rs), which the shell shows where the press was.

// What the rail's tile says about this computer while the reader is elsewhere (device/badge.ts), read off the store.
const badge = computed(() => {
    const device = useDevice();
    return deviceBadge({
        settingUp: device.activeRun.value === `setup`,
        sandbox: device.pending.value?.name,
        fixing: device.fixRunning.value ? device.fixName.value : undefined,
        waiting: device.setupMode.value || device.syncSetup.value?.error !== undefined,
        startingDocker: device.dockerStarting.value,
        updateReady: device.update.value.kind === `ready`,
    });
});

/** This device: this computer's sandboxes, its machine agent, its engine and the app's work on it (device/DeviceView.vue). */
const DEVICE_VIEW: LocalView = {
    path: `device`,
    section: `devices`,
    title: () => t(`desktop.device.title`),
    load: () => import(`./device/DeviceView.vue`),
    badge,
};

/* A FOLDER'S OWN SANDBOX, made from its window (the app's project.rs) and built in it: this window's setup store runs the
   setup (device/setup.ts `adoptSetup`), and the card over the folder draws it (the web's local/LocalProject.vue). */

// Whether the sandbox image was on this computer when the dialog was drawn: the build's plan weighs no download then.
let imageWasReady = false;

// What a press came to, the setup started here when there is one to run.
const started = (created: ProjectCreated): LocalProjectStart => {
    if (created.kind === `setup`) {
        // Not awaited: the build runs for its minutes while the page goes on, and its card follows the store.
        void useDevice().adoptSetup(created.setup, { imageReady: imageWasReady });
        return `building`;
    }
    return created.kind === `signIn` ? `signIn` : `opened`;
};

const PROJECT: LocalProjectHost = {
    preview: async () => {
        const preview = await projectPreview();
        if (preview.kind === `new`) {
            imageWasReady = preview.imageReady;
        }
        return preview;
    },
    create: async (names) => started(await projectCreate(names)),
    build: computed(() => {
        const device = useDevice();
        return projectBuildOf({
            adopted: device.adopted.value,
            state: device.setupState.value,
            view: device.progressShown.value,
            error: device.setupError.value,
        });
    }),
    open: async () => {
        const adopted = useDevice().adopted.value;
        await workspaceOpen(adopted === undefined ? undefined : projectPathOf(adopted));
    },
    // The same sandbox, set up again: the app mints its code afresh, or hands back the one still good.
    retry: async () => {
        const adopted = useDevice().adopted.value;
        if (adopted === undefined || adopted.name === undefined || adopted.project === undefined) {
            return;
        }
        started(await projectCreate({ name: adopted.name, project: adopted.project, ...(adopted.sandboxId === undefined ? {} : { sandboxId: adopted.sandboxId }) }));
    },
    stop: () => useDevice().stopSetup(),
    dismiss: () => useDevice().forgetAdopted(),
    // This device, where the build's every step, its log and anything it asks of the reader are drawn.
    detailsPath: `/${DEVICE_VIEW.path}`,
};

export const nativeHost = (): LocalHost => ({
    native: true,
    views: [DEVICE_VIEW],
    facts: async () => {
        const facts = await homeFacts();
        return { accountSeen: facts.accountSeen, homeFolder: facts.homeFolder };
    },
    places: () => localRecents(),
    roster: () => localRoster(),
    point: (path) => localPoint(path),
    open: (path) => localOpenPath(path),
    pickFolder: () => localPick(true),
    pickFile: () => localPick(false),
    forget: (path) => localForgetRecent(path),
    found: () => foundOnMachine(),
    signIn: () => signIn(),
    openWorkspace: (path) => workspaceOpen(path),
    account: () => readAccount(),
    updateAccount: (change) => updateAccount(change),
    signOut: () => signOutAccount(),
    project: PROJECT,
});

/**
 * Hands the window its host, and starts its reading of the machine: the main window's takes the work the app parks for
 * it (a setup, a recreate, a sync, a sleeping engine), so the page it shows for that work finds it already running.
 *
 * A page with no app behind it (the built local face in a test's browser, _tools/e2e/local-face) keeps the web's
 * link-only host: every command here would throw there, and the shell draws the folder without them.
 */
export const installHost = (face: LocalFace): void => {
    if (!(`__TAURI_INTERNALS__` in window)) {
        return;
    }
    window.__INTENTIC_LOCAL_HOST__ = nativeHost();
    void startReading(face.home === true);
};

// The window's reading of the machine, started once; a failure is the console's, since the page draws what it has.
const startReading = async (takesWork: boolean): Promise<void> => {
    try {
        await useDevice().startDevice({ takesWork });
    } catch (error) {
        console.error(`[device] this computer could not be read:`, error);
    }
};
