import type { SandboxSummary } from "@intentic/api-contract";
import { computed, ref, type Ref, watch } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import type { apiClient } from "../../../lib/useApi";
import type { useSandbox } from "../../sandbox/client/useSandbox";
import { type Arrival, arrivalFor, hostedIdle, rowToOpen, touched } from "../setupArrival";
import { lanesFor, readOffer } from "../setupLanes";
import { type Machine, type MachineOption, requestedRung } from "./machineLadder";
import type { CommandLaneApi } from "./useCommandLane";
import type { HostedLaneApi } from "./useHostedLane";
import type { SetupRow } from "./useSetupRow";

// What arriving on /setup does by itself, once: reads the platform's two offers with the account's rows, settles the row
// this visit works on, decides the arrival (setupArrival.ts) and takes it, and hands the setup to the app the moment a
// code exists for the `local` arrival. No identity or machine question is asked of the reader here.

type Platform = (typeof apiClient)[`sandbox`];
type SandboxStore = ReturnType<typeof useSandbox>;

export interface SetupArrivalHost {
    readonly sandbox: Pick<SandboxStore, `list` | `select`>;
    readonly platform: Pick<Platform, `hostedOffer` | `addressOffer`>;
    readonly row: SetupRow;
    readonly hosted: Pick<
        HostedLaneApi,
        | `machine`
        | `hostedRead`
        | `hostedRow`
        | `hostedOffered`
        | `hostedSpent`
        | `hostedFull`
        | `recordOffer`
        | `handBackMachine`
        | `provisionHosted`
        | `resumeHosted`
    >;
    readonly command: Pick<CommandLaneApi, `addressRead` | `addressed` | `commandReady` | `recordOffer`>;
    // Where `?sandbox=`, `?machine=` and `?elsewhere=1` are read.
    readonly route: Pick<RouteLocationNormalizedLoaded, `query`>;
    readonly inApp: Readonly<Ref<boolean>>;
    // The rungs on offer, which a `?machine=` must name to count.
    readonly ladder: Readonly<Ref<readonly MachineOption[]>>;
    // One silent attempt at the browser's sandbox credential while the reader watches a machine boot.
    readonly warmCredential: () => Promise<void>;
    // Hands the setup to the desktop app.
    readonly runHere: () => void;
}

export const useSetupArrival = ({ sandbox, platform, row, hosted, command, route, inApp, ladder, warmCredential, runHere }: SetupArrivalHost) => {
    // `choose` until the offers and the row land, so nothing folds on an unanswered read.
    const arrival = ref<Arrival>(`choose`);
    // Rungs the arrival did not take are folded, not absent; `?elsewhere=1`, or its link, reveals them.
    const elsewhere = ref(route.query[`elsewhere`] === `1`);
    // Whether the arrival read has answered; without it the first frame reads as a failed create.
    const loaded = ref(false);
    // The app handoff fires once: a re-mint (a lane switch, a retry) is ordinary, and must not reopen the app's
    // installer window each time.
    const handedOff = ref(false);

    // What the provision spine can offer (setupLanes.ts); the page states it and never switches lanes on it.
    const lanes = computed(() =>
        lanesFor({ address: command.addressRead.value, hosted: hosted.hostedRead.value, hasMachine: hosted.hostedRow.value !== null }),
    );
    // A lane to take, worth drawing the ladder for; otherwise a card just explains itself.
    const laneTakeable = computed(() => lanes.value.kind === `takeable`);

    // Settles the row this visit works on, creating a fresh draft when there is none to resume; whether that row carries
    // a machine nothing has ever run on.
    const openRow = async (rows: readonly SandboxSummary[]): Promise<boolean> => {
        const named = route.query[`sandbox`];
        const found = rowToOpen(rows, typeof named === `string` ? named : undefined);
        if (found === undefined) {
            await row.autoCreate();
            return false;
        }
        sandbox.select(found.id);
        row.created.value = found;
        row.resuming.value = touched(found);
        return hostedIdle(found);
    };

    // This computer is the answer while a machine sits on the row: hand it back exactly as the rung does, since the local
    // lane mints no code until the row carries none. False when the platform refused, so the machine is still there.
    const handBackForHere = async (asked: Machine | undefined): Promise<boolean> => {
        if (hosted.hostedRow.value === null || (arrival.value !== `local` && asked !== `mine`) || (await hosted.handBackMachine())) {
            return true;
        }
        // The picker says so, rather than a card awaiting a code that will never be minted.
        hosted.machine.value = `hosted`;
        return false;
    };

    // Does what the decided arrival says: hands a machine back, resumes one, or starts one. False means what it wanted was
    // refused, and the picker comes back with the reason already on the card.
    const takeArrival = async (asked: Machine | undefined): Promise<boolean> => {
        if (!(await handBackForHere(asked))) {
            return false;
        }
        // A resumed sandbox still hosted continues that story; booting or asleep is the wake reflex's to handle.
        if (hosted.hostedRow.value !== null) {
            hosted.resumeHosted();
            void warmCredential();
            return true;
        }
        if (arrival.value === `hosted`) {
            hosted.machine.value = `hosted`;
            if (!(await hosted.provisionHosted())) {
                return false;
            }
            void warmCredential();
            return true;
        }
        // The app's answer is this computer, and the handoff fires the moment there is a code to hand.
        if (arrival.value === `local`) {
            hosted.machine.value = `mine`;
        }
        return true;
    };

    const arrive = async (): Promise<void> => {
        // The offers land with the row list, so the ladder and the address line are right on the first frame.
        const [rows, hostedRead, addressRead] = await Promise.all([
            sandbox.list(),
            readOffer(() => platform.hostedOffer(), { enabled: false, remaining: 0 }),
            readOffer(() => platform.addressOffer(), { enabled: false }),
        ]);
        hosted.recordOffer(hostedRead);
        command.recordOffer(addressRead);
        const idleMachine = await openRow(rows);
        // A rung picked before this page outranks the arrival: it preselects the picker and is `arrivalFor`'s own answer.
        const asked = requestedRung(ladder.value, route.query[`machine`]);
        if (asked !== undefined) {
            hosted.machine.value = asked;
        }
        arrival.value = arrivalFor({
            inApp: inApp.value,
            // Read before any create, so a row minted seconds ago is never counted as company for itself.
            onlySandbox: rows.every((entry) => entry.id === row.created.value?.id),
            touched: row.resuming.value,
            hostedIdle: idleMachine,
            // Only `autoCreate` sets it, so it means exactly that this visit minted the row.
            fresh: row.createdHere.value,
            hostedOffered: hosted.hostedOffered.value,
            hostedSpent: hosted.hostedSpent.value,
            hostedFull: hosted.hostedFull.value,
            commandOffered: command.addressed.value,
            requestedMachine: asked,
            elsewhere: elsewhere.value,
        });
        // Nothing takeable means nothing to start: the page states which lane fact holds and switches nothing.
        if (laneTakeable.value && !(await takeArrival(asked))) {
            arrival.value = `choose`;
        }
    };

    // Reads the arrival, again as the retry: it finds the same unfinished row rather than making a second. `loaded`
    // drops for the round trip and returns either way, so a thrown read leaves the retry card rather than a spinner.
    const readArrival = async (): Promise<void> => {
        loaded.value = false;
        try {
            await arrive();
        } finally {
            loaded.value = true;
        }
    };

    watch([arrival, command.commandReady], () => {
        if (arrival.value !== `local` || !command.commandReady.value || handedOff.value) {
            return;
        }
        handedOff.value = true;
        runHere();
    });

    // A replacement sandbox lands on the picker rather than another automatic start, and may be handed to the app anew.
    const forget = (): void => {
        arrival.value = `choose`;
        handedOff.value = false;
    };

    return { arrival, elsewhere, loaded, lanes, laneTakeable, readArrival, forget };
};
