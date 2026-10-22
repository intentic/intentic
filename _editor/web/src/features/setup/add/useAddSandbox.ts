import type { SetupCode } from "@intentic/api-contract";
import { syncFolder } from "@intentic/sandbox-contract/ids/hostnames";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, type Ref } from "vue";
import { track } from "../../../app/analytics";
import { type DesktopSetupArgs, desktopSetupLink } from "../../../app/environments/desktop";
import { arrivingProfile } from "../../../app/useProfile";
import type { apiClient } from "../../../lib/useApi";
import { autoSandboxName, SANDBOX_NAME_MAX } from "../../../client/sandbox/sandboxName";
import type { MachineDoor } from "../../sandbox/live/sandboxDoors";
import { readOffer } from "../setupLanes";
import { type HostedLaneApi, type HostedLaneHost, useHostedLane } from "../flow/useHostedLane";
import { type RegistryWatchHost, useRegistryWatch } from "../flow/useRegistryWatch";
import { HERE, type SetupOnMachineApi, useSetupOnMachine } from "../flow/useSetupOnMachine";
import { type SetupRow, type SetupRowHost, useSetupRow } from "../flow/useSetupRow";

// ADDING A SANDBOX WHEN THE ACCOUNT ALREADY WORKS IN ONE: a name and where it runs, then one press. /setup is the first
// run's page: it decides by itself where a first sandbox runs, explains every way there, and fills the screen while it
// does. Someone who already has a sandbox and presses "Add sandbox" was sent there and asked first whether they did not
// mean the one they had (2026-10-22), then given the whole onboarding to pick a machine they already knew. So the add
// is a dialog over the workspace (AddSandboxDialog.vue), offering only what starts in one press:
//
//   - this computer, inside the desktop app, handed to the app with a fresh code as /setup's button hands it;
//   - each connected machine that can make a sandbox (useSetupOnMachine's doors), pressed as /setup presses it;
//   - a machine of ours, while the account has one to start (useHostedLane, the same lane /setup runs).
//
// Everything else (the command, the installer, an own Cloudflare zone, an address already answering) stays on /setup,
// one link away as "More ways". The row is made only on the press, so there is no draft to discard on Cancel; one whose
// start was refused before anything reached a machine is deleted again, the draft rule /setup keeps. Once a machine has
// the code the row is kept, and the getting-started ring's "Finish setting up" reopens it on /setup if the dialog is
// closed. The flows are /setup's own, keyed by the row, so that page resumes exactly the run this dialog started.

type Platform = (typeof apiClient)[`sandbox`];

/** The pick for a machine of ours, beside `HERE` and the connected machines' keys. */
export const HOSTED = `hosted`;

// The registry watch records a code's claim only for the code it was minted under; this dialog mints one per row.
const MINTED = `add`;

export interface AddSandboxHost {
    readonly sandbox: SetupRowHost[`sandbox`] & HostedLaneHost[`sandbox`] & RegistryWatchHost[`sandbox`];
    readonly platform: HostedLaneHost[`platform`] & Pick<Platform, `setupCode` | `addressOffer` | `hostedOffer`>;
    // Inside the desktop app, where "This computer" is one press.
    readonly inApp: () => boolean;
    // Whether the owner's connected machines can be read from this window: a folder window of the app cannot read other
    // sandboxes' daemons, through which they are reached.
    readonly machines: () => boolean;
    // A dev build run from a checkout makes its image there, which no press elsewhere can.
    readonly buildsFromCheckout: boolean;
    // The local-dev platform this build runs against, carried to the app as /setup carries it.
    readonly platformUrl: string | undefined;
    readonly mobile: Readonly<Ref<boolean>>;
    readonly openDesktopLink: (link: string) => void;
    // One silent try at the browser's sandbox credential while a machine of ours boots (Setup.vue's own).
    readonly warmCredential: () => Promise<void>;
    // The row has reported in and is selected: open it.
    readonly enter: () => Promise<void>;
}

export interface AddOption {
    readonly value: string;
    readonly label: string;
    readonly icon: `desktop` | `server` | `cloud`;
}

/** Why a typed name cannot be used, or undefined when it can. */
export const nameProblem = (name: string): string | undefined => {
    const clean = name.trim();
    if (clean === ``) {
        return t(`setup.addSandbox.nameNeeded`);
    }
    return clean.length > SANDBOX_NAME_MAX ? t(`setup.addSandbox.nameTooLong`, { max: SANDBOX_NAME_MAX }) : undefined;
};

/** The pick shown: the reader's while it is still on offer, else the first on offer, which is the likeliest. */
export const pickOf = (picked: string | undefined, options: readonly AddOption[]): string | undefined =>
    options.some((option) => option.value === picked) ? picked : options[0]?.value;

type Started = { readonly kind: `here` } | { readonly kind: `machine`; readonly door: MachineDoor } | { readonly kind: `hosted` };

// The flows /setup runs, on the row this dialog makes.
interface Flows {
    readonly host: AddSandboxHost;
    readonly row: SetupRow;
    readonly hosted: HostedLaneApi;
    readonly setup: Ref<SetupCode | null>;
    readonly mintedFor: Ref<string | undefined>;
}

// Where it can run: the platform's two offers, read once the dialog opens (an unreadable one offers nothing rather
// than guessing), and the connected machines that can make a sandbox.
const useAddOffers = ({ host, row, hosted, setup }: Flows) => {
    // Whether this platform mints addresses, which a code (this computer, a connected machine) needs; unread until `read`.
    const addressed = ref(false);
    const loaded = ref(false);
    const codeOffered = computed(() => addressed.value && !host.buildsFromCheckout);
    const onMachine = useSetupOnMachine({ offered: () => codeOffered.value && host.machines(), created: row.created, setup, mobile: host.mobile });
    // A machine of ours only while one can start now: offered, room left, not switched off, not waiting on a Google link.
    const hostedTakeable = computed(
        () =>
            hosted.hostedOffered.value &&
            !hosted.hostedSpent.value &&
            !hosted.hostedFull.value &&
            !hosted.hostedSuspended.value &&
            hosted.hostedOffer.value?.needsGoogle !== true,
    );
    const options = computed<readonly AddOption[]>(() => [
        ...(codeOffered.value && host.inApp() ? [{ value: HERE, label: t(`setup.setupOnMachine.thisComputer`), icon: `desktop` as const }] : []),
        ...onMachine.doors.value.map((door) => ({ value: door.machineKey, label: door.machineLabel, icon: `server` as const })),
        ...(hostedTakeable.value ? [{ value: HOSTED, label: t(`setup.addSandbox.intenticMachine`), icon: `cloud` as const }] : []),
    ]);
    const read = async (): Promise<void> => {
        const [address, offer] = await Promise.all([
            readOffer(() => host.platform.addressOffer(), { enabled: false }),
            readOffer(() => host.platform.hostedOffer(), { enabled: false, remaining: 0 }),
        ]);
        addressed.value = address.kind === `answered` && address.value.enabled;
        hosted.recordOffer(offer);
        loaded.value = true;
    };
    return { loaded, onMachine, options, read };
};

// The form: the next free name, kept current with the account's list until the reader types one of their own, and the
// pick, which falls back to what is on offer.
const useAddForm = (rows: Readonly<Ref<readonly { readonly name: string }[]>>, options: Readonly<Ref<readonly AddOption[]>>) => {
    const typed = ref<string | undefined>(undefined);
    const name = computed<string>({
        get: () => typed.value ?? autoSandboxName(rows.value.map((entry) => entry.name)),
        set: (next) => {
            typed.value = next;
        },
    });
    const picked = ref<string | undefined>(undefined);
    const pick = computed<string | undefined>({
        get: () => pickOf(picked.value, options.value),
        set: (next) => {
            picked.value = next;
        },
    });
    return { name, pick, problem: computed(() => nameProblem(name.value)) };
};

// The app on this computer, handed the code as /setup's button hands it, syncing a folder of this computer by default.
const handToApp = (host: AddSandboxHost, minted: SetupCode, sandboxId: string, sandboxName: string): void => {
    const link: DesktopSetupArgs = {
        code: minted.code,
        sandboxId,
        name: sandboxName,
        syncDir: syncFolder(sandboxName, minted.hostname),
        profile: arrivingProfile(),
    };
    if (host.platformUrl !== undefined) {
        link.platformUrl = host.platformUrl;
    }
    host.openDesktopLink(desktopSetupLink(link));
};

// The two ways a start goes after the row exists: a machine of ours, or a code handed to the app or a connected machine.
const useAddStarts = (flows: Flows, onMachine: SetupOnMachineApi) => {
    const { host, row, hosted, setup, mintedFor } = flows;
    // Where the press went, once it went: the dialog draws that run instead of the form. Undefined again after a start
    // refused before anything reached a machine, so the form comes back with the reason on it.
    const started = ref<Started>();
    const error = ref<NoticeModel | null>(null);

    // Taken back: the row goes, as /setup's draft goes, and the form returns with why.
    const refused = async (notice: NoticeModel): Promise<void> => {
        error.value = notice;
        started.value = undefined;
        setup.value = null;
        mintedFor.value = undefined;
        await row.discardDraft(false);
    };

    const startHosted = async (): Promise<void> => {
        hosted.machine.value = `hosted`;
        started.value = { kind: `hosted` };
        if (await hosted.provisionHosted()) {
            void host.warmCredential();
            return;
        }
        const title = hosted.hostedFull.value ? t(`setup.setup.outMachinesRightNow`) : t(`setup.addSandbox.hostedNeedsGoogle`);
        await refused(hosted.hostedError.value ?? { tone: `warning`, title });
    };

    const startWithCode = async (target: string, sandboxId: string, sandboxName: string): Promise<void> => {
        let minted: SetupCode;
        try {
            minted = await host.platform.setupCode({ sandboxId, profile: arrivingProfile() });
        } catch (err) {
            await refused(noticeFrom(err, t(`setup.useCommandLane.couldntPrepare`)));
            return;
        }
        setup.value = minted;
        mintedFor.value = MINTED;
        if (target === HERE) {
            started.value = { kind: `here` };
            handToApp(host, minted, sandboxId, sandboxName);
            return;
        }
        const door = onMachine.doors.value.find((each) => each.machineKey === target);
        if (door === undefined) {
            await refused({ tone: `warning`, title: t(`setup.addSandbox.machineGone`) });
            return;
        }
        started.value = { kind: `machine`, door };
        onMachine.target.value = target;
        // A failed run keeps the row: the code reached the machine, and "Try again" presses it once more.
        await onMachine.setUpOn();
    };

    return { started, error, startHosted, startWithCode };
};

export const useAddSandbox = (host: AddSandboxHost) => {
    const { sandbox, platform } = host;
    const row = useSetupRow({ sandbox, enter: host.enter });
    const hosted = useHostedLane({ platform, sandbox, row, project: undefined, appTakesProjects: () => false });
    const flows: Flows = { host, row, hosted, setup: ref<SetupCode | null>(null), mintedFor: ref<string | undefined>(undefined) };
    // Opens the workspace once the row reports in (and, for a machine of ours, once it is ready to be used).
    useRegistryWatch({ sandbox, row, hosted, mintedFor: flows.mintedFor });
    const { loaded, onMachine, options, read } = useAddOffers(flows);
    const { name, pick, problem } = useAddForm(sandbox.sandboxes, options);
    const { started, error, startHosted, startWithCode } = useAddStarts(flows, onMachine);
    const creating = ref(false);

    // The row is made only on the press, under the typed name, then started where it was picked.
    const create = async (): Promise<void> => {
        const target = pick.value;
        if (creating.value || started.value !== undefined || target === undefined || problem.value !== undefined) {
            return;
        }
        creating.value = true;
        error.value = null;
        try {
            const sandboxName = name.value.trim();
            try {
                row.created.value = await sandbox.create(sandboxName);
                row.createdHere.value = true;
            } catch (err) {
                error.value = noticeFrom(err, t(`setup.setup.couldNotCreateSandbox`));
                return;
            }
            track(`sandbox_add_started`, { target: target === HERE ? `here` : target === HOSTED ? `hosted` : `machine` });
            await (target === HOSTED ? startHosted() : startWithCode(target, row.created.value.id, sandboxName));
        } finally {
            creating.value = false;
        }
    };

    return {
        name,
        problem,
        pick,
        options,
        loaded,
        creating,
        error,
        started,
        created: row.created,
        hostedWait: hosted.hostedWait,
        hostedRow: hosted.hostedRow,
        onMachine,
        read,
        create,
        // The same press on the same machine, with the same code: a run that failed never claimed it.
        retry: () => onMachine.setUpOn(),
    };
};
