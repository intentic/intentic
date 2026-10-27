import type { SandboxSummary } from "@intentic/api-contract";
import { type HostedTierId, isHostedTierId } from "@intentic/constants";
import { t } from "@intentic/ui/i18n";
import type { DesktopSetupReport } from "../../../app/environments/desktopSetupReport";
import { ref, shallowRef, type Ref } from "vue";
import type { HistoryState, LocationQuery } from "vue-router";
import { z } from "zod";
import { ADD_SANDBOX_QUERY, ADD_SANDBOX_VALUE } from "../../../models/sandbox/addSandbox";
import { FINISH_QUERY } from "../../../models/sandbox/finishOnHome";
import type { AddSandboxHere } from "../../setup/add/useAddSandboxHere";

// A NEW SANDBOX IS MADE ON HOME, IN A TILE OF ITS OWN (2026-10-26). The + on Home's rail, its first-run page, and every
// other "Add sandbox" on a desktop (the switcher inside a sandbox, the palette, a folder window of the app) open Home
// with a dialog over it asking for a name and where it runs (NewSandboxDialog.vue). Create closes it and leaves the
// reader on the chat they were in, with a tile at the end of the sandboxes wearing the rail's spinning mark: the sandbox
// it will be. Pressing the tile shows the run's progress in the chat's place (HomeNewSandbox.vue), and any other tile
// takes the reader back. Once it is ready, a reader watching lands on its home conversation, and one who is elsewhere
// finds the tile marked ready instead of being pulled off what they are doing. A first sandbox has no chat to go back
// to, so its reader is left on the progress.
//
// (2026-10-26, the owner's) The first cut put the form in the chat's place too, behind a dashed tile already selected;
// the form is a dialog again so the press is one step over whatever was on screen, and nothing moves until it is made.
// Before both, a dialog over Home whose run, picked to happen on this computer, swapped the desktop app's window over to
// This device to watch a bar Home could already draw (desktop.ts `DesktopSetupArgs.stay`), and which, once closed, left
// the sandbox nowhere on screen until it reported in. A phone, with no rail, keeps the dialog that draws its run as well
// (models/sandbox/addSandbox.ts).
//
// The run outlives its dialog and its page: NewSandboxHost.vue holds it, mounted by the shell while Home asks for the new
// sandbox or a run is under way, and publishes it here for the dialog, the page and the tile (NewSandboxTile.vue) to draw.
//
// A SETUP LEFT UNFINISHED IS FINISHED THE SAME WAY (2026-10-26): Home's first run offers it by name, and its press asks
// Home to finish that row (`?finish=<id>`), which puts up its tile and its page with no dialog: a machine of ours already
// on it waited on, the app's run on this computer, or its command again. It used to go to /setup, which handed the install
// to the app, and the app swapped This computer in over the workspace for as long as it ran; /setup is gone since, and
// every address of it lands here (router/setupRoutes.ts).
//
// HOME'S ADDRESS FOR IT: `/home?add=sandbox` asks for the dialog; `finish=<id>` finishes that row instead; `machine=hosted`
// picks a machine of ours (`tier=<id>` names its tier, the pricing page's); `found=<ids>` names the AI tools the desktop app
// found signed in here, offered once the sandbox is open (lib/foundOnComputer.ts).

type HomeAddress = { readonly name?: unknown; readonly query: LocationQuery };

/** Whether an address of Home asks for the new sandbox: `/home?add=sandbox`, its dialog or its run's page. */
export const newSandboxShownBy = (route: HomeAddress): boolean => route.name === `home` && route.query[ADD_SANDBOX_QUERY] === ADD_SANDBOX_VALUE;

const RowId = z.string().min(1);
const BackPath = z.string().startsWith(`/`);

/** The row an address of Home asks to finish (`/home?add=sandbox&finish=<id>`), or undefined when it asks for a new one. */
export const finishAskedBy = (route: HomeAddress): string | undefined => {
    const asked = RowId.safeParse(route.query[FINISH_QUERY]);
    return newSandboxShownBy(route) && asked.success ? asked.data : undefined;
};

/**
 * Whether closing the dialog may step Back to the entry before it. Not onto a sign-in page: a returning reader is signed in
 * again there without a press and sent on to the same ask, so the dialog came straight back, for as long as it was
 * closed (2026-10-27). Not onto an address that is itself the ask (Home's, or an old setup address that lands on it).
 */
export const closesBackTo = (back: HistoryState[`back`]): boolean => {
    const read = BackPath.safeParse(back);
    if (!read.success) {
        return false;
    }
    const [path = ``, search = ``] = read.data.split(`?`, 2);
    if (path.startsWith(`/login`) || path === `/setup` || path === `/start/hosted`) {
        return false;
    }
    return new URLSearchParams(search).get(ADD_SANDBOX_QUERY) !== ADD_SANDBOX_VALUE;
};

/** The rung Home's address asks for (`machine=hosted`), and the tier asked of it (`tier=`); undefined where none is named. */
export const machineAskedBy = (route: HomeAddress): `hosted` | undefined => (route.query[`machine`] === `hosted` ? `hosted` : undefined);
export const tierAskedBy = (route: HomeAddress): HostedTierId | undefined => {
    const tier = route.query[`tier`];
    return isHostedTierId(tier) ? tier : undefined;
};


/** The new sandbox as its host publishes it. */
export interface NewSandboxRun {
    readonly here: AddSandboxHere;
    /** Create was pressed: from then the tile stands until the run ends or is put away, page or no page. */
    readonly pressed: Readonly<Ref<boolean>>;
    /** The row reported in and was selected: what is left is its first start. */
    readonly opening: Readonly<Ref<boolean>>;
    /** A setup left unfinished is what this run finishes, rather than a sandbox it makes: there is no form to go back to. */
    readonly resumed: Readonly<Ref<boolean>>;
    /** The press, so the tile stands from it. */
    readonly create: () => Promise<void>;
    /** The press on a setup left unfinished, finished in place (on a machine of ours where `asked`); the tile stands from it as from Create. */
    readonly resume: (row: SandboxSummary, asked?: `hosted`) => Promise<void>;
    /** The same press again after it failed: a code the platform would not give, or a run on a machine that stopped. */
    readonly retry: () => void;
    /** Its first start is on screen: the page gives way to its home conversation. */
    readonly opened: () => void;
    /** Put away: a form never pressed, a refusal, or a run that failed and was let go. */
    readonly dismiss: () => void;
}

// allow(module-state): the one new sandbox this window is making, published by its host while it lives
export const newSandbox = shallowRef<NewSandboxRun | undefined>();

// allow(module-state): a run under way, which keeps its host mounted once its page is left
export const newSandboxBusy = ref(false);

// allow(module-state): bumped as a run ends, so the shell mounts a fresh host for the next one rather than reusing a spent one
export const newSandboxGeneration = ref(0);

// allow(module-state): sandboxes that became ready while their reader was elsewhere, marked on their tiles until opened
export const readySandboxes = ref<ReadonlySet<string>>(new Set());

/** A sandbox made ready while nobody watched: its tile says so until it is opened. */
export const markReady = (sandboxId: string): void => {
    readySandboxes.value = new Set([...readySandboxes.value, sandboxId]);
};

/** Opened: the tile's mark goes. */
export const seenReady = (sandboxId: string): void => {
    if (readySandboxes.value.has(sandboxId)) {
        readySandboxes.value = new Set([...readySandboxes.value].filter((id) => id !== sandboxId));
    }
};

/** What the dialog, the page and the tile decide on: whether Create was pressed, and whether the press went somewhere. */
type RunOnScreen = {
    readonly pressed: Readonly<Ref<boolean>>;
    readonly resumed: Readonly<Ref<boolean>>;
    readonly here: { readonly add: { readonly started: Readonly<Ref<unknown>> } };
};

/** Finishing a setup left unfinished, asked for or under way: it has a page from the press on, and never a dialog. */
const finishing = (route: HomeAddress, run: RunOnScreen): boolean => run.resumed.value || finishAskedBy(route) !== undefined;

/** Asked for and nothing started yet (a press still in flight, or one the platform refused): the dialog takes the name. */
export const newSandboxDialogShown = (route: HomeAddress, run: RunOnScreen | undefined): boolean =>
    newSandboxShownBy(route) && run !== undefined && run.here.add.started.value === undefined && !finishing(route, run);

/** Asked for once the press went somewhere: the run's progress stands in the chat's place, and its tile is the selected one. */
export const newSandboxPageShown = (route: HomeAddress, run: RunOnScreen | undefined): boolean =>
    newSandboxShownBy(route) && run !== undefined && (run.here.add.started.value !== undefined || finishing(route, run));

/** The tile stands from the press, except while the dialog still holds it (in flight, or refused and shown again). */
export const newSandboxTileShown = (route: HomeAddress, run: RunOnScreen | undefined): boolean =>
    run !== undefined && run.pressed.value && !newSandboxDialogShown(route, run);

/** Where the new sandbox stands, as its tile wears it. */
export type NewSandboxPhase = `draft` | `running` | `asking` | `failed` | `opening`;

/** What a reading is made of: the run's own refs, read flat. */
export interface NewSandboxFacts {
    readonly pressed: boolean;
    readonly opening: boolean;
    readonly started: `here` | `machine` | `hosted` | `command` | `attach` | undefined;
    readonly refused: boolean;
    readonly machineFailed: boolean;
    readonly hostedFailed: boolean;
    /** The machine running the command said what broke. */
    readonly commandFailed?: boolean;
    readonly report: Pick<DesktopSetupReport, `state` | `percent` | `waitingFor`> | undefined;
}

/**
 * Where the new sandbox stands. A refusal, a run on a machine that failed, a machine of ours that could not start, and
 * the app's run failing or being stopped are all `failed`; the app waiting on its own question (a consent, a restart, a
 * sign-out) is `asking`, since it waits on the reader; this PC's own setup coming first is not, it carries on by itself.
 */
export const newSandboxPhase = (facts: NewSandboxFacts): NewSandboxPhase => {
    if (!facts.pressed) {
        return `draft`;
    }
    if (facts.opening) {
        return `opening`;
    }
    if (
        facts.refused ||
        (facts.started === `machine` && facts.machineFailed) ||
        (facts.started === `hosted` && facts.hostedFailed) ||
        (facts.started === `command` && facts.commandFailed === true)
    ) {
        return `failed`;
    }
    const report = facts.report;
    if (facts.started === `here` && report !== undefined) {
        if (report.state === `failed` || report.state === `stopped`) {
            return `failed`;
        }
        if (report.state === `waiting` && report.waitingFor !== `pcSetup`) {
            return `asking`;
        }
    }
    return `running`;
};

/** The tile's line under its name, in the hover and its accessible name; the app's own percent while it gives one. */
export const newSandboxNote = (phase: NewSandboxPhase, facts: Pick<NewSandboxFacts, `started` | `report`>): string => {
    switch (phase) {
        case `draft`:
            return t(`home.newSandbox.tile.draft`);
        case `opening`:
            return t(`home.newSandbox.tile.opening`);
        case `asking`:
            return t(`home.newSandbox.tile.asking`);
        case `failed`:
            return facts.started === undefined ? t(`home.newSandbox.tile.refused`) : t(`home.newSandbox.tile.failed`);
        default: {
            const percent = facts.started === `here` && facts.report?.state === `running` ? Math.round(facts.report.percent) : undefined;
            return percent === undefined || percent <= 0
                ? t(`home.newSandbox.tile.running`)
                : t(`home.newSandbox.tile.runningPercent`, { percent });
        }
    }
};

/** What the new sandbox's page and tile draw: where it stands, said in a line, under the name it has or will have. */
export interface NewSandboxReading {
    readonly phase: NewSandboxPhase;
    readonly note: string;
    readonly name: string;
}

/** The published run read flat, as its page and its tile both read it; undefined while there is none. */
export const readNewSandbox = (run: NewSandboxRun | undefined): NewSandboxReading | undefined => {
    if (run === undefined) {
        return undefined;
    }
    const { add, desktopReport } = run.here;
    const started = add.started.value?.kind;
    const facts: NewSandboxFacts = {
        pressed: run.pressed.value,
        opening: run.opening.value,
        started,
        refused: add.error.value !== null && started === undefined,
        machineFailed: add.onMachine.run.failure.value !== undefined,
        hostedFailed: add.hostedRow.value !== null && add.hostedWait.value.failure !== undefined,
        commandFailed: add.command.wait.reportFailures.value !== null,
        report: desktopReport.value,
    };
    const phase = newSandboxPhase(facts);
    return { phase, note: newSandboxNote(phase, facts), name: add.created.value?.name ?? add.name.value.trim() };
};
