import { DEVICE_FEATURE_BACKGROUND_PREPARE, deviceSupports, hostRunningSandbox } from "@intentic/sandbox-contract";
import { computed, type Ref, ref, watch } from "vue";
import { rpcPrefix } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";
import { manageDeviceSandbox, useDevices } from "../../devices/useDevices";
import { mayStart } from "./updateDownload";

// THE UPDATE CARD STARTS THE DOWNLOAD IT IS ABOUT TO OFFER. The machine agent's own timer downloads every running
// sandbox's next update within a few hours (auto-prepare.ts); someone opening the card is the moment it is wanted now.
// So the card asks the machine that runs this sandbox for that same unattended download (`prepare-background`, which
// is `ic sandbox prepare --auto`: low disk is "not now", a pinned sandbox and the version it went back from are left
// alone). Only a connected machine whose agent says it can, once per release per half hour in this tab, and silently
// like the timer: a refusal, a skip or a failure leaves the card offering Update now, which downloads on its own.

/** The release the card offers and the sandbox it is for, while the card wants it downloaded; undefined otherwise. */
export interface DownloadWanted {
    readonly slug: string;
    readonly version: string;
}

// Per tab, so a reload within the half hour does not ask again, and a fresh tab tomorrow does.
const askedKey = (wanted: DownloadWanted): string => `intentic.update.download-asked.${wanted.slug}.${wanted.version}`;
const lastAsked = (wanted: DownloadWanted): number | undefined => {
    const said = Number(globalThis.sessionStorage?.getItem(askedKey(wanted)) ?? Number.NaN);
    return Number.isFinite(said) ? said : undefined;
};
const noteAsked = (wanted: DownloadWanted, at: number): void => {
    globalThis.sessionStorage?.setItem(askedKey(wanted), String(at));
};

/** What the card draws from: whether its own request is still out, before the machine says how far it got. */
export interface BackgroundDownload {
    readonly starting: Ref<boolean>;
}

export function useBackgroundDownload(wanted: () => DownloadWanted | undefined): BackgroundDownload {
    const { devices } = useDevices({ poll: false });
    // The door the sandbox runs behind, by the one rule every "run it out there" path shares, and whether its agent
    // says it runs this op: the daemon refuses it to one that does not, so asking would only fail.
    const hostId = computed(() => hostRunningSandbox(devices.value, wanted()?.slug));
    const able = computed(() => {
        const id = hostId.value;
        const door = id === undefined ? undefined : devices.value.find((device) => device.hostId === id);
        return deviceSupports(door?.facts, DEVICE_FEATURE_BACKGROUND_PREPARE);
    });
    // Out from the ask until the machine answers; the card draws a download starting meanwhile, since the machine's
    // own marker only appears once the pull has something to say.
    const starting = ref(false);

    const ask = async (id: string, want: DownloadWanted): Promise<void> => {
        noteAsked(want, Date.now());
        starting.value = true;
        try {
            await manageDeviceSandbox(id, want.slug, `prepare-background`);
        } catch {
            // allow(silent-catch): the timer's own rule. A refusal (an older sandbox, an agent switched off) or a failure is the timer's to retry, and the card still offers Update now, which downloads by itself.
        } finally {
            starting.value = false;
            // Downloaded, current, or skipped: the card reads which from the sandbox rather than from this answer.
            void queryClient.invalidateQueries({ queryKey: rpcPrefix(`system.info`) });
        }
    };

    watch(
        () => [wanted(), hostId.value, able.value] as const,
        ([want, id, can]) => {
            if (want !== undefined && id !== undefined && can && !starting.value && mayStart(lastAsked(want), Date.now())) {
                void ask(id, want);
            }
        },
        { immediate: true },
    );

    return { starting };
}
