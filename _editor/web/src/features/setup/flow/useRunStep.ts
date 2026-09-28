import type { SetupCode } from "@intentic/api-contract";
import { syncFolder } from "@intentic/sandbox-contract";
import { commandLang } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, ref, type Ref } from "vue";
import { track } from "../../../app/analytics";
import { desktopSetupLink } from "../../../app/environments/desktop";
import type { desktopInstaller } from "../../../app/environments/desktopDownloads";
import { environment } from "../../../app/environments/environment";
import { scriptSource } from "../../../app/environments/scriptCommand";
import type { SetupProject } from "../setupArrival";
import type { ComposeArgs } from "../setupCompose";
import { installCommand, platformUrlOf, uninstallCommand, webOriginOf } from "./installCommand";
import type { SetupRow } from "./useSetupRow";

// Step 2 on the reader's own machine: which shell's command is on screen, and whether it is on screen at all (it folds
// behind the app's button, the phone's handoff or an offered installer), what rides with it, and the handoff to the
// desktop app, which runs the same code through the same connect script. A project setup has no command: only the app
// knows where its folder is, and a pasted command could only sync /work into a folder made up here.

export interface SetupReader {
    // A phone gets a different step 2 (a handoff, not a narrower command).
    readonly mobile: Readonly<Ref<boolean>>;
    // Inside the desktop app, where step 2 is one button.
    readonly inApp: Readonly<Ref<boolean>>;
    // The installer offered in place of the raw pipe, where a build ships for this machine.
    readonly installer: Readonly<Ref<ReturnType<typeof desktopInstaller>>>;
}

export interface RunStepHost {
    readonly command: {
        readonly setup: Readonly<Ref<SetupCode | null>>;
        readonly commandReady: Readonly<Ref<boolean>>;
        // Set once the app is handed the code.
        readonly launched: Ref<boolean>;
    };
    readonly row: Pick<SetupRow, `created`>;
    readonly reader: SetupReader;
    // The preferred shell, persisted across screens.
    readonly cmdOs: Ref<`unix` | `windows`>;
    readonly mode: Readonly<Ref<`intentic` | `own`>>;
    readonly cfToken: Readonly<Ref<string>>;
    // The folder the app is setting this sandbox up for, fixed for the visit.
    readonly project: SetupProject | undefined;
    readonly openDesktopLink: (link: string) => void;
}

export const useRunStep = ({ command, row, reader, cmdOs, mode, cfToken, project, openDesktopLink }: RunStepHost) => {
    const { mobile, inApp, installer } = reader;
    // Set up by the app's button: in the app, and for a project wherever this page is, whose link reaches the app by the
    // OS from a browser too.
    const throughApp = computed(() => inApp.value || project !== undefined);
    // The compose tab is this page's own: choosing it must not overwrite the unix/windows preference.
    const composeSelected = ref(false);
    const showCommand = ref(false);
    // Drops `sudo` where the machine already has Docker; a claim about the paste target, so never persisted.
    const hasDocker = ref(false);
    // Desktop sync, on by default: the folder rides the command as SYNC_DIR.
    const syncEnabled = ref(true);
    // The local-dev platform this build runs against, if any.
    const platformUrl = platformUrlOf(environment.api.url);
    const webOrigin = webOriginOf(globalThis.location.origin);

    const runTab = computed<`unix` | `windows` | `compose`>({
        get: () => (composeSelected.value ? `compose` : cmdOs.value),
        set: (value) => {
            composeSelected.value = value === `compose`;
            if (value !== `compose`) {
                cmdOs.value = value;
            }
        },
    });
    // Labels shed a qualifier on a phone; compose's own label lives in its panel's first line, not the tab.
    const runTabOptions = computed(() => [
        { label: t(`ui.useOsPreference.linuxMacos`), value: `unix` as const },
        { label: mobile.value ? `Windows` : `Windows (PowerShell)`, value: `windows` as const },
        { label: mobile.value ? `Compose` : `Docker Compose`, value: `compose` as const, title: t(`setup.setup.noScriptRunsRead`) },
    ]);
    const appFirst = computed(() => installer.value !== undefined);
    // The command folds away wherever it isn't the path: the app's button, the phone's handoff, an offered installer. A
    // project's is never on screen.
    const commandVisible = computed(() => project === undefined && (inApp.value || mobile.value || appFirst.value ? showCommand.value : true));
    // Compose declares its own environment: only the compose tab on screen, not merely no command, hides sync.
    const composeShown = computed(() => commandVisible.value && runTab.value === `compose`);
    // Installing through the app with the command folded away.
    const installing = computed(() => appFirst.value && !commandVisible.value);
    // A failed run is retried with the app's button wherever no command is on screen to run again.
    const retriedByButton = computed(() => !commandVisible.value && (throughApp.value || installing.value));
    // Empty until the mint lands, and for a project always: its folder is the one the reader picked, not one made up here.
    const syncDir = computed(() =>
        project === undefined && row.created.value && command.setup.value ? syncFolder(row.created.value.name, command.setup.value.hostname) : ``,
    );
    // The made-up folder rides the command and the app's link only while the switch is on.
    const syncRides = computed(() => project === undefined && syncEnabled.value);
    // Sync exists only where the command does: not before the mint, not on compose, not for hosted; it survives the
    // app's fold. A project's is the folder itself, stated rather than offered, in the same place.
    const syncOffered = computed(() => command.commandReady.value && !composeShown.value && (commandVisible.value || throughApp.value));
    // Only the path form, run from a checkout, has a repo to build the dev image from.
    const buildsFromCheckout = computed(() => platformUrl !== undefined && scriptSource.value === `checkout`);
    // The reader's own Cloudflare token rides the command on the own-zone path only.
    const ownToken = (): string | undefined => (mode.value === `own` ? cfToken.value.trim() : undefined);

    const selectedCommand = computed(() => {
        const code = command.setup.value?.code;
        if (code === undefined) {
            return ``;
        }
        return installCommand({
            os: cmdOs.value,
            code,
            cfToken: ownToken(),
            platformUrl,
            fromCheckout: buildsFromCheckout.value,
            webOrigin,
            syncDir: syncRides.value ? syncDir.value : undefined,
            // Root only installs Docker, and only in production: in local dev it breaks the pnpm-built image.
            sudo: environment.production && !hasDocker.value,
        });
    });
    const selectedCommandLang = computed(() => commandLang(cmdOs.value));
    const cleanupCommand = computed(() => uninstallCommand(cmdOs.value));
    const composeArgs = computed<ComposeArgs | undefined>(() => {
        const minted = command.setup.value;
        if (minted === null) {
            return undefined;
        }
        return {
            code: minted.code,
            hostname: minted.hostname,
            // The published image always: a deploy target cannot pull the local `:dev` tag.
            image: `ghcr.io/intentic/sandbox:stable`,
            googleClientId: environment.auth.googleClientId,
            webOrigin: globalThis.location.origin,
            ...(platformUrl === undefined ? {} : { platformUrl }),
        };
    });

    // Hands the setup to the desktop app: the same code and connect script, run by a process already on the machine.
    const runHere = (): void => {
        const code = command.setup.value?.code;
        const target = row.created.value;
        if (code === undefined || target === null) {
            return;
        }
        track(`desktop_setup_started`, { mode: mode.value, inApp: inApp.value, sync: syncRides.value, project: project !== undefined });
        command.launched.value = true;
        const token = ownToken();
        openDesktopLink(
            desktopSetupLink({
                code,
                sandboxId: target.id,
                name: target.name,
                ...(token === undefined ? {} : { cfToken: token }),
                syncDir: syncRides.value ? syncDir.value : undefined,
                project: project?.dirName,
                ...(platformUrl === undefined ? {} : { platformUrl }),
            }),
        );
    };

    return {
        runTab,
        runTabOptions,
        showCommand,
        hasDocker,
        syncEnabled,
        throughApp,
        appFirst,
        commandVisible,
        composeShown,
        installing,
        retriedByButton,
        syncDir,
        syncOffered,
        buildsFromCheckout,
        webOrigin,
        selectedCommand,
        selectedCommandLang,
        cleanupCommand,
        composeArgs,
        runHere,
    };
};

export type RunStepApi = ReturnType<typeof useRunStep>;
