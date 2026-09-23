import type { AddressOffer, SandboxSummary, SetupCode } from "@intentic/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onScopeDispose, ref, type Ref, watch } from "vue";
import { arrivingProfile } from "../../../app/useProfile";
import type { apiClient } from "../../../lib/useApi";
import { isNotFound, type OfferRead } from "../setupLanes";
import type { Machine } from "./machineLadder";
import type { SetupRow } from "./useSetupRow";

// The own-computer lane's setup code: the address offer that gates it, the code minted for this row (debounced against
// keystrokes, never kept for a target the reader has left), and what has happened to that code since. The command
// carries only the code; the platform provisions the tunnel and DNS behind it first.

type Platform = (typeof apiClient)[`sandbox`];

// Quiet time after the target settles before a code is minted for it (ms).
const MINT_DEBOUNCE_MS = 500;

export interface CommandLaneHost {
    readonly platform: Pick<Platform, `setupCode`>;
    readonly row: Pick<SetupRow, `created` | `claimedAt`>;
    // A hosted rung, a machine on the row, or one being handed back: the machine holds its own tunnel, so no code.
    readonly hosted: {
        readonly machine: Readonly<Ref<Machine>>;
        readonly hostedRow: Readonly<Ref<SandboxSummary[`hosted`]>>;
        readonly releasingHosted: Readonly<Ref<boolean>>;
    };
    // Which lane step 1 heads: attach records a reachable domain and never redeems a code.
    readonly lane: Readonly<Ref<`provision` | `attach`>>;
}

export const useCommandLane = ({ platform, row, hosted, lane }: CommandLaneHost) => {
    const { created } = row;
    // Three-valued: said-no and never-answered differ, and nothing is printed off a read that never landed.
    const addressRead = ref<OfferRead<boolean>>({ kind: `unreachable` });
    // Undefined until the arrival answers, so no rung is drawn that would have to be retracted once it does.
    const intenticAvailable = ref<boolean | undefined>(undefined);
    // The minted {code, hostname, expiresAt}; the command carries only the code.
    const setup = ref<SetupCode | null>(null);
    const setupError = ref<NoticeModel | undefined>(undefined);
    // The target `setup` was minted for, so a re-fired watch does not mint again and a stale mint is discarded.
    const mintedFor = ref<string | undefined>(undefined);
    // The command was copied: persistent, unlike the copy button's flash, since the handoff card turns on it.
    const copied = ref(false);
    // The app was handed the code, the last thing observable before the machine takes over.
    const launched = ref(false);
    let mintTimer: ReturnType<typeof setTimeout> | undefined;

    // The platform mints addresses: the answer is in and it is yes; every lane that needs one gates on this.
    const addressed = computed(() => intenticAvailable.value === true);
    // The answer is in and it is no, which is a fact to state rather than a wait.
    const addressless = computed(() => intenticAvailable.value === false);

    // What a code is minted for: the row (switching sandboxes invalidates a stale mint) and its token. None for attach,
    // for a hosted machine (it holds its own tunnel), or on a platform with no addresses (asking would only spin).
    const targetKey = computed<string | undefined>(() => {
        const target = created.value;
        if (
            target === null ||
            lane.value === `attach` ||
            hosted.machine.value === `hosted` ||
            hosted.hostedRow.value !== null ||
            hosted.releasingHosted.value
        ) {
            return undefined;
        }
        return addressed.value ? `${target.id}:${target.token}` : undefined;
    });

    // The command can be built only once the chosen target has a code minted for it.
    const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);

    // The arrival's read of the offer; a lost read leaves availability unknown rather than false.
    const recordOffer = (read: OfferRead<AddressOffer>): void => {
        addressRead.value = read.kind === `answered` ? { kind: `answered`, value: read.value.enabled } : { kind: `unreachable` };
        intenticAvailable.value = read.kind === `answered` ? read.value.enabled : undefined;
    };

    // NOT_FOUND means the platform runs no tunnel fabric: the attach lane is then the only honest offer left.
    const mint = async (key: string): Promise<void> => {
        if (created.value === null) {
            return;
        }
        setupError.value = undefined;
        try {
            // The profile rides the code, not the command: the machine seeds its half of it from what the claim hands back.
            const minted = await platform.setupCode({ sandboxId: created.value.id, profile: arrivingProfile() });
            if (key !== targetKey.value) {
                return;
            }
            setup.value = minted;
            mintedFor.value = key;
            // A fresh code restarts the handoff: the old command was the one copied or handed, and its claim is moot.
            copied.value = false;
            launched.value = false;
            row.claimedAt.value = null;
        } catch (err) {
            if (isNotFound(err)) {
                intenticAvailable.value = false;
            } else if (key === targetKey.value) {
                setupError.value = noticeFrom(err, `Couldn't prepare your install command. Try again.`);
            }
        }
    };

    // Mints once the target completes, debounced against keystrokes; switching lanes re-fires this by itself.
    watch(
        targetKey,
        (key) => {
            clearTimeout(mintTimer);
            if (key === undefined || created.value === null || mintedFor.value === key) {
                return;
            }
            mintTimer = setTimeout(() => void mint(key), MINT_DEBOUNCE_MS);
        },
        { immediate: true },
    );
    onScopeDispose(() => clearTimeout(mintTimer));

    // Retries a failed mint, which the watch never does: a failure changes nothing about what was asked for.
    const remint = (): void => {
        const key = targetKey.value;
        if (key === undefined) {
            return;
        }
        setupError.value = undefined;
        void mint(key);
    };

    // A new sandbox gets a new code: everything minted or done for the old one goes.
    const forget = (): void => {
        setup.value = null;
        mintedFor.value = undefined;
        setupError.value = undefined;
        copied.value = false;
        launched.value = false;
    };

    return {
        addressRead,
        intenticAvailable,
        addressed,
        addressless,
        setup,
        setupError,
        mintedFor,
        copied,
        launched,
        commandReady,
        recordOffer,
        remint,
        forget,
    };
};

export type CommandLaneApi = ReturnType<typeof useCommandLane>;
