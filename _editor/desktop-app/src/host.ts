import { t } from "@intentic/ui/i18n";
import type { LocalFace } from "@intentic/web/local";
import type { LocalHost, LocalMachineAction, LocalProjectHost, LocalView } from "@intentic/web/local-host";
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
    projectAttach,
    projectPreview,
    signIn,
    workspaceOpen,
} from "./desktop";
import { deviceBadge } from "./device/badge";
import {
    machineFolderOf,
    machineSandbox,
    recreateMachine,
    retryMachine,
    revealMachineLog,
    startMachine,
    startMachineSandbox,
} from "./device/machineSandbox";
import { folderOf, machineOf, machineStateOf, projectPathOf } from "./device/projectBuild";
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
        machine: machineSandbox.value?.state,
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

/* A FOLDER'S WAY TO AN AGENT: this computer's own sandbox, which the app makes after sign-in and keeps (the app's
   machine_sandbox.rs, device/machineSandbox.ts), and the window's folder on its way into it (project.rs
   `project_attach`). Nothing here runs anything: the app does, whichever window is open, and every window hears it. */

// The folder this window shows, by the path the app told it: how its own entry in the record is found.
const folderPath = (): string | undefined => {
    const face = window.__INTENTIC_LOCAL__;
    return face === undefined || face.file !== undefined ? undefined : face.path;
};

const MACHINE_ACTIONS: Readonly<Record<LocalMachineAction, () => Promise<void>>> = {
    signIn: () => signIn(),
    // This window's own start of the engine, the one This device's card draws; the app looks again once it answers.
    startDocker: () => useDevice().startDocker(`card`),
    retry: () => retryMachine(),
    start: () => startMachine(),
    recreate: () => recreateMachine(),
    log: () => revealMachineLog(),
};

const PROJECT: LocalProjectHost = {
    preview: async () => {
        const preview = await projectPreview();
        return preview.kind === `new` ? { ...preview, machine: machineStateOf(preview.machine) } : preview;
    },
    attach: async (names) => {
        const attached = await projectAttach(names);
        return attached.kind === `queued` ? `queued` : `opened`;
    },
    machine: computed(() => machineOf(machineSandbox.value)),
    folder: computed(() => folderOf(machineSandbox.value, folderPath())),
    // The folder's sandbox, opened on the folder: this computer's, under the folder's name in it.
    open: async () => {
        const record = machineSandbox.value;
        const folder = machineFolderOf(record, folderPath());
        await workspaceOpen(projectPathOf({ sandboxId: record?.sandboxId, project: folder?.name }));
    },
    act: (action) => MACHINE_ACTIONS[action](),
    // This device, where this computer's sandbox, its every step and anything it asks of the reader are drawn.
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
    // Every window follows this computer's own sandbox: its card is in each of them while it is not ready.
    void startMachineSandbox();
};

// The window's reading of the machine, started once; a failure is the console's, since the page draws what it has.
const startReading = async (takesWork: boolean): Promise<void> => {
    try {
        await useDevice().startDevice({ takesWork });
    } catch (error) {
        console.error(`[device] this computer could not be read:`, error);
    }
};
