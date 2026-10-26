import type { SandboxSummary, SetupCode } from "@intentic/api-contract";
import type { HostedTierId } from "@intentic/constants";
import { syncFolder } from "@intentic/sandbox-contract/ids/hostnames";
import type { NoticeModel } from "@intentic/ui";
import { engineCapacity, type OsMark } from "@intentic/ui/device-machine";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, type Ref } from "vue";
import { track } from "../../../app/analytics";
import { type DesktopSetupArgs, desktopSetupLink, desktopSetupStopLink } from "../../../app/environments/desktop";
import { arrivingProfile } from "../../../app/useProfile";
import type { apiClient } from "../../../lib/useApi";
import { autoSandboxName, SANDBOX_NAME_MAX } from "../../../client/sandbox/sandboxName";
import { osLabel, osMark } from "../../../models/sandbox/devices/deviceFacts";
import type { MachineDoor } from "../../sandbox/live/sandboxDoors";
import { touched } from "../setupArrival";
import type { probeDaemon } from "../setupAttach";
import { readOffer } from "../setupLanes";
import { type HostedLaneApi, type HostedLaneHost, useHostedLane } from "../flow/useHostedLane";
import type { AttachLaneHost } from "../flow/useAttachLane";
import { type RegistryWatchHost, useRegistryWatch } from "../flow/useRegistryWatch";
import { HERE, type SetupOnMachineApi, useSetupOnMachine } from "../flow/useSetupOnMachine";
import { type SetupRow, type SetupRowHost, useSetupRow } from "../flow/useSetupRow";
import { useAddAttach } from "./useAddAttach";
import { useAddCommand } from "./useAddCommand";

// THE NEW SANDBOX, MADE IN PLACE (Home's dialog and page; a phone's dialog). One press for what starts in one press: this
// computer in the app, a connected machine, a machine of ours. "More ways" in the same form, never another page: a command
// to run on a server (with the reader's own Cloudflare zone if they want), or an address a sandbox already answers on.
// The row is made only on the press (an address's only once it let this account in), deleted if refused before any
// machine got its code, kept once one did. A setup left unfinished is finished here too (`resume`): a machine of ours
// already on its row is waited on, this computer runs it in the app, and anywhere else its command is shown again.
// (2026-10-26) The other ways lived on /setup, a page of its own that took the reader off Home; it is gone, and its old
// addresses land here (router/setupRoutes.ts).

type Platform = (typeof apiClient)[`sandbox`];

/** The pick for a machine of ours, beside `HERE` and the connected machines' keys. */
export const HOSTED = `hosted`;
/** "More ways": a command to run on a server, and an address a sandbox already answers on. */
export const COMMAND = `command`;
export const ATTACH = `attach`;

// The registry watch records a code's claim only for the code it was minted under; this dialog mints one per row.
const MINTED = `add`;

export interface AddSandboxHost {
    readonly sandbox: SetupRowHost[`sandbox`] & HostedLaneHost[`sandbox`] & RegistryWatchHost[`sandbox`] & AttachLaneHost[`sandbox`];
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
    // This page draws the app's install itself (Home's new sandbox), so the app runs it out of sight rather than
    // swapping This device in over the page (desktop.ts `DesktopSetupArgs.stay`).
    readonly appStays?: boolean;
    readonly mobile: Readonly<Ref<boolean>>;
    readonly openDesktopLink: (link: string) => void;
    // One silent try at the browser's sandbox credential while a machine of ours boots.
    readonly warmCredential: () => Promise<void>;
    // The row has reported in and is selected: open it.
    readonly enter: () => Promise<void>;
    // The tier a machine of ours is asked for (the pricing page's choice), carried by Home's address; the free one otherwise.
    readonly tier?: HostedTierId | undefined;
    // The browser's own sandbox credential, which an address already answering is probed with before it is recorded.
    readonly getIdToken: () => Promise<string | undefined>;
    readonly probe: typeof probeDaemon;
}

export interface AddOption {
    readonly value: string;
    readonly label: string;
    readonly icon: `desktop` | `server` | `cloud` | `terminal` | `link`;
    /** The line under the label: what the pick IS (a machine's OS and engine, the free hours left) or what it does. */
    readonly note?: string;
    /** The OS a connected machine runs, in its own colour, in place of `icon`. */
    readonly mark?: OsMark | undefined;
}

// A connected machine as the pick says it: its OS and the engine every sandbox there shares ("Arch Linux on WSL · 32 GiB
// · 16 cores"), both read off the side a new sandbox is made on; a machine that never described itself is just connected.
const machineOption = (door: MachineDoor): AddOption => {
    const side = door.side;
    const engine = side?.facts?.engine;
    const note = [side === undefined ? undefined : osLabel(side), engine === undefined ? undefined : engineCapacity(engine)].filter(Boolean).join(` · `);
    return {
        value: door.machineKey,
        label: door.machineLabel,
        icon: `server`,
        note: note === `` ? t(`setup.addSandbox.machineNote`) : note,
        mark: side === undefined ? undefined : osMark(side),
    };
};

// A machine of ours: the free hours this account has left this month where it is metered, else only where it runs.
const hostedNote = (hours: { readonly remaining: number } | undefined): string =>
    hours === undefined ? t(`setup.addSandbox.hostedNote`) : t(`setup.addSandbox.hostedHoursNote`, { hours: hours.remaining }, hours.remaining);

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

type Started =
    | { readonly kind: `here` }
    | { readonly kind: `machine`; readonly door: MachineDoor }
    | { readonly kind: `hosted` }
    // A code minted for the row, its command on the page to run on a server.
    | { readonly kind: `command` }
    // An address already answering, recorded on the row: what is left is its first start.
    | { readonly kind: `attach` };

/** Why a machine of ours is not among the picks, said where it was asked for: by name, or the only way there is. */
export type HostedProblem = `google` | `occupied` | `full` | `restricted`;

// The flows /setup runs, on the row this dialog makes.
interface Flows {
    readonly host: AddSandboxHost;
    readonly row: SetupRow;
    readonly hosted: HostedLaneApi;
    readonly setup: Ref<SetupCode | null>;
    readonly mintedFor: Ref<string | undefined>;
}

// Where it can run: the platform's two offers, read once the dialog opens (an unreadable one offers nothing rather
// than guessing), and the connected machines that can make a sandbox. "More ways" beside them: the command wherever the
// platform mints addresses (a checkout's dev build included, whose command builds its image), and an address always.
const useAddOffers = ({ host, row, hosted, setup }: Flows) => {
    // Whether this platform mints addresses, which a code (this computer, a connected machine) needs; unread until `read`.
    const addressed = ref(false);
    const loaded = ref(false);
    const codeOffered = computed(() => addressed.value && !host.buildsFromCheckout);
    const onMachine = useSetupOnMachine({ offered: () => codeOffered.value && host.machines(), created: row.created, setup, mobile: host.mobile });
    // Why a machine of ours cannot start now; undefined while it can, and where the platform hosts none at all.
    const hostedProblem = computed<HostedProblem | undefined>(() => {
        if (!hosted.hostedOffered.value) {
            return undefined;
        }
        if (hosted.hostedSuspended.value) {
            return `restricted`;
        }
        if (hosted.hostedOffer.value?.needsGoogle === true || hosted.refusedForGoogle.value) {
            return `google`;
        }
        if (hosted.hostedSpent.value) {
            return `occupied`;
        }
        return hosted.hostedFull.value ? `full` : undefined;
    });
    const options = computed<readonly AddOption[]>(() => [
        ...(codeOffered.value && host.inApp()
            ? [{ value: HERE, label: t(`setup.setupOnMachine.thisComputer`), icon: `desktop` as const, note: t(`setup.addSandbox.hereNote`) }]
            : []),
        ...onMachine.doors.value.map(machineOption),
        ...(hosted.hostedOffered.value && hostedProblem.value === undefined
            ? [{ value: HOSTED, label: t(`setup.addSandbox.intenticMachine`), icon: `cloud` as const, note: hostedNote(hosted.hostedOffer.value?.hours) }]
            : []),
    ]);
    const moreOptions = computed<readonly AddOption[]>(() => [
        ...(addressed.value
            ? [{ value: COMMAND, label: t(`setup.addSandbox.wayCommand`), icon: `terminal` as const, note: t(`setup.addSandbox.wayCommandNote`) }]
            : []),
        { value: ATTACH, label: t(`setup.addSandbox.wayAttach`), icon: `link` as const, note: t(`setup.addSandbox.wayAttachNote`) },
    ]);
    const read = async (): Promise<void> => {
        const tier = host.tier;
        const [address, offer] = await Promise.all([
            readOffer(() => host.platform.addressOffer(), { enabled: false }),
            readOffer(() => (tier === undefined ? host.platform.hostedOffer() : host.platform.hostedOffer({ tier })), { enabled: false, remaining: 0 }),
        ]);
        addressed.value = address.kind === `answered` && address.value.enabled;
        hosted.recordOffer(offer);
        loaded.value = true;
    };
    return { loaded, codeOffered, onMachine, options, moreOptions, hostedProblem, read };
};

// The form: the next free name, kept current with the account's list until the reader types one of their own, and the
// pick, which falls back to what is on offer.
const useAddForm = (rows: Readonly<Ref<readonly { readonly name: string }[]>>, options: Readonly<Ref<readonly AddOption[]>>) => {
    // (The first on offer is the likeliest: a one-press way before any of "More ways", which `options` lists last.)
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
    if (host.appStays === true) {
        link.stay = true;
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
        if (target === COMMAND) {
            started.value = { kind: `command` };
            return;
        }
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

type AddOffers = ReturnType<typeof useAddOffers>;
type AddForm = ReturnType<typeof useAddForm>;
type AddStarts = ReturnType<typeof useAddStarts>;

// The presses on what the form holds: make it, finish one left unfinished, or take the app's run to a machine of ours.
const useAddPresses = (flows: Flows, offers: AddOffers, form: AddForm, starts: AddStarts, attach: ReturnType<typeof useAddAttach>) => {
    const { host, row, hosted } = flows;
    const { name, pick, problem } = form;
    const { started, error, startHosted, startWithCode } = starts;
    const creating = ref(false);
    // Whether the press can go now: a usable name, a pick on offer, and for an address one that could be one.
    const blocked = computed(
        () =>
            problem.value !== undefined ||
            pick.value === undefined ||
            (pick.value === ATTACH && (attach.normalizedDomain.value === undefined || attach.ownAddress.value !== undefined)),
    );
    const busy = computed(() => creating.value || attach.attaching.value);

    // The row is made only on the press, under the typed name, then started where it was picked. An address makes it
    // only once the sandbox there let this account in.
    const create = async (): Promise<void> => {
        const target = pick.value;
        if (busy.value || started.value !== undefined || target === undefined || blocked.value) {
            return;
        }
        if (target === ATTACH) {
            track(`sandbox_add_started`, { target: `attach` });
            await attach.connect();
            return;
        }
        creating.value = true;
        error.value = null;
        try {
            const sandboxName = name.value.trim();
            try {
                row.created.value = await host.sandbox.create(sandboxName);
                row.createdHere.value = true;
            } catch (err) {
                error.value = noticeFrom(err, t(`setup.setup.couldNotCreateSandbox`));
                return;
            }
            track(`sandbox_add_started`, { target: target === HERE || target === HOSTED || target === COMMAND ? target : `machine` });
            await (target === HOSTED ? startHosted() : startWithCode(target, row.created.value.id, sandboxName));
        } finally {
            creating.value = false;
        }
    };

    // A setup of the reader's own left unfinished, finished here as a new one is made (Home's `?finish=<id>`): the row it
    // has, never another. A machine of ours already on it is waited on, and one is started on it where it was asked for
    // (`machine=hosted`, the failure mail's second link) and can start; anything else gets a fresh code, run by the app on
    // this computer where there is one, else shown as the command to run. A refusal keeps the row, which was never this
    // press's to discard (`createdHere`), and says why.
    const resume = async (existing: SandboxSummary, asked?: `hosted`): Promise<void> => {
        if (creating.value || started.value !== undefined) {
            return;
        }
        creating.value = true;
        error.value = null;
        try {
            if (!offers.loaded.value) {
                await offers.read();
            }
            row.created.value = existing;
            row.createdHere.value = false;
            row.resuming.value = touched(existing);
            name.value = existing.name;
            if ((existing.hosted ?? null) !== null) {
                track(`sandbox_add_started`, { target: `hosted`, resumed: true });
                started.value = { kind: `hosted` };
                hosted.resumeHosted();
                void host.warmCredential();
                return;
            }
            if (asked === `hosted` && hosted.hostedOffered.value && offers.hostedProblem.value === undefined) {
                track(`sandbox_add_started`, { target: `hosted`, resumed: true });
                await startHosted();
                return;
            }
            const target = offers.codeOffered.value && host.inApp() ? HERE : COMMAND;
            track(`sandbox_add_started`, { target, resumed: true });
            await startWithCode(target, existing.id, existing.name);
        } finally {
            creating.value = false;
        }
    };

    // The app's install on this computer given up for a machine of ours on the same row (a slow download, a restart the
    // reader would rather not make): the app stops it, since the machine takes over the sandbox's address, and the run
    // becomes the machine's wait. Offered only while one can start now.
    const hostedInstead = computed(() => started.value?.kind === `here` && hosted.hostedOffered.value && offers.hostedProblem.value === undefined);
    const toHosted = async (): Promise<void> => {
        const target = row.created.value;
        if (!hostedInstead.value || target === null) {
            return;
        }
        host.openDesktopLink(desktopSetupStopLink(target.id));
        track(`sandbox_add_hosted_instead`, {});
        await startHosted();
    };

    return { creating, blocked, busy, create, resume, hostedInstead, toHosted };
};

export const useAddSandbox = (host: AddSandboxHost) => {
    const { sandbox, platform } = host;
    const row = useSetupRow({ sandbox, enter: host.enter });
    const hosted = useHostedLane({ platform, sandbox, row, project: undefined, appTakesProjects: () => false, tier: host.tier });
    const flows: Flows = { host, row, hosted, setup: ref<SetupCode | null>(null), mintedFor: ref<string | undefined>(undefined) };
    // Opens the workspace once the row reports in (and, for a machine of ours, once it is ready to be used).
    useRegistryWatch({ sandbox, row, hosted, mintedFor: flows.mintedFor });
    const offers = useAddOffers(flows);
    const form = useAddForm(
        sandbox.sandboxes,
        computed(() => [...offers.options.value, ...offers.moreOptions.value]),
    );
    const starts = useAddStarts(flows, offers.onMachine);
    // The command a code was minted for, and how its run is waited on (useAddCommand.ts).
    const command = useAddCommand({ setup: flows.setup, started: starts.started, row, mobile: host.mobile });
    // An address already answering: probed first, the row made only once it let this account in (useAddAttach.ts).
    const attach = useAddAttach({ host, row, error: starts.error, name: form.name, started: starts.started, minted: () => flows.setup.value?.hostname });
    const presses = useAddPresses(flows, offers, form, starts, attach);

    return {
        ...form,
        ...presses,
        options: offers.options,
        moreOptions: offers.moreOptions,
        hostedProblem: offers.hostedProblem,
        loaded: offers.loaded,
        onMachine: offers.onMachine,
        read: offers.read,
        error: starts.error,
        started: starts.started,
        created: row.created,
        claimedAt: row.claimedAt,
        // The code minted for the row, and the address it names.
        minted: flows.setup,
        mobile: host.mobile,
        hostedWait: hosted.hostedWait,
        hostedRow: hosted.hostedRow,
        hostedBusy: hosted.hostedBusy,
        restartHosted: hosted.restartHosted,
        command,
        attach,
        // The same press on the same machine, with the same code: a run that failed never claimed it.
        retry: () => offers.onMachine.setUpOn(),
    };
};
