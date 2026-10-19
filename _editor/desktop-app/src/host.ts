import { t } from "@intentic/ui/i18n";
import { type LocalFace, localFace } from "@intentic/web/local";
import type { LocalHost, LocalMachineAction, LocalProjectHost, LocalView } from "@intentic/web/local-host";
import { computed } from "vue";
import { track } from "./analytics";
import { readAccount, signOutAccount, updateAccount } from "./account";
import { onboardingHost } from "./onboarding";
import { pcStanding } from "./onboarding/pc";
import { repairHost } from "./repair";
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
import { startDockerAndSay } from "./device/docker";
import { machineFolderOf, machineSandbox, machineVerbs, startMachineSandbox } from "./device/machineSandbox";
import { followOnScreen } from "./onScreen";
import { folderOf, machineOf, machineStateOf, projectPathOf } from "./device/projectBuild";
import { useDevice } from "./device/useDevice";
import { followPasswords, passwordsBadge, passwordsInRail } from "./passwords/passwordsState";

// THE APP'S HALF OF A LOCAL WINDOW'S SHELL (the web's app/environments/localHost.ts): what the editor asks of this
// computer, answered by the app's own commands, the account the workspace signed in with (account.ts), and the view the
// app adds to the rail, This device and Passwords. Installed on the
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
        movingSandboxes: device.engineMoving.value !== undefined,
        waiting: device.setupMode.value || device.syncSetup.value?.error !== undefined,
        startingDocker: device.dockerStarting.value,
        // A deb or rpm upgrade installed under the running app is one restart away too.
        updateReady: device.update.value.kind === `ready` || device.update.value.kind === `installed`,
        machine: machineSandbox.value?.state,
        // Only Windows has this PC's own setup: elsewhere its check speaks of Docker, which the tile already does.
        pc: device.info.value?.os === `windows` ? pcStanding.value : undefined,
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

/** Passwords: this computer's vault, its requests and its settings, the app @intentic/ext-passwords/app mounts. */
const PASSWORDS_VIEW: LocalView = {
    path: `passwords`,
    section: `passwords`,
    title: () => t(`desktop.passwords.title`),
    // The app's words are mounted first, as the extension host would mount them, so its first paint is in words.
    load: async () => {
        const { registerPasswordsMessages } = await import(`@intentic/ext-passwords/app`);
        await registerPasswordsMessages();
        return import(`./passwords/PasswordsPage.vue`);
    },
    badge: passwordsBadge,
    // Off the rail until this computer has Passwords set up; This device offers the setup until then.
    inRail: passwordsInRail,
};

/* A FOLDER'S WAY TO AN AGENT: this computer's own sandbox, which the app makes after sign-in and keeps (the app's
   machine_sandbox.rs, device/machineSandbox.ts), and the window's folder on its way into it (project.rs
   `project_attach`). Nothing here runs anything: the app does, whichever window is open, and every window hears it. */

// The folder this window shows, by the path the app told it: how its own entry in the record is found. Read through the
// editor's own reader, so the card's computed below follows a folder pointed at in this window's place.
const folderPath = (): string | undefined => {
    const face = localFace();
    return face === undefined || face.file !== undefined ? undefined : face.path;
};

// Each rejects with the sentence the card says under its press (localHost.ts `LocalHost`): the app's refusal, or how a
// start of the engine ended.
const MACHINE_ACTIONS: Readonly<Record<LocalMachineAction, () => Promise<void>>> = {
    signIn: () => signIn(),
    // This window's own start of the engine, the one This device's card draws; the app looks again once it answers.
    startDocker: () => startDockerAndSay(),
    retry: () => machineVerbs.retry(),
    start: () => machineVerbs.start(),
    recreate: () => machineVerbs.recreate(),
    log: () => machineVerbs.log(),
};

const PROJECT: LocalProjectHost = {
    preview: async () => {
        const preview = await projectPreview();
        return preview.kind === `new` ? { ...preview, machine: machineStateOf(preview.machine) } : preview;
    },
    attach: async (names) => {
        try {
            const attached = await projectAttach(names);
            const outcome = attached.kind === `queued` ? `queued` : `opened`;
            track(`project_attach`, { outcome });
            return outcome;
        } catch (error) {
            track(`project_attach`, { outcome: `failed` });
            throw error;
        }
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
    views: [DEVICE_VIEW, PASSWORDS_VIEW],
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
    onboarding: onboardingHost(),
    repair: repairHost(),
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
    // Whether the window is on screen, heard from before the app first says it (onScreen.ts).
    followOnScreen();
    void startReading(face.home === true);
    // Every window follows this computer's own sandbox: its card is in each of them while it is not ready.
    void startMachineSandbox();
    // And what Passwords' tile says: requests waiting, passwords just saved.
    followPasswords();
};

// The window's reading of the machine, started once; a failure is the console's, since the page draws what it has.
const startReading = async (takesWork: boolean): Promise<void> => {
    try {
        await useDevice().startDevice({ takesWork });
    } catch (error) {
        console.error(`[device] this computer could not be read:`, error);
    }
};
