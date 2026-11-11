import type { HubSave, HubSaved, HubState, HubTake, HubTaken, HubTarget, HubWant } from "@intentic/sandbox-contract/schemas/connection-hub";
import type { NoticeModel } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type MaybeRefOrGetter, type Ref, toValue, watch } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useRole } from "../../client/sandbox/useRole";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { useOperations } from "../../workbench/operations/operations";
import { capabilitiesKey } from "../capabilities/useCapabilities";
import { refreshConnections } from "../conversations/accounts/useChat-accounts";
import { type HubRowView, holdingOf, hubNote, readyComputers, saveTargets, targetKey, wantKey } from "./connectionHub";

// THE WIRE behind connectionHub.ts: the hub as this sandbox answers it, read where a surface offers it, and its two
// presses. Saving puts a card or account on one of the owner's computers; taking asks the computers for one, which the
// sandbox then makes into a card or account here. Each press is kept in the operations ledger, by what it was about, so
// a reader who leaves while the computer is asked comes back to its answer.

export interface HubWire {
    /** The hub as the sandbox last answered it, read while `enabled` holds, and read again every so often while `polling` does. */
    readonly read: (enabled: Readonly<Ref<boolean>>, polling: Readonly<Ref<boolean>>) => { readonly data: Readonly<Ref<HubState | undefined>> };
    readonly save: (input: HubSave) => Promise<HubSaved>;
    readonly take: (input: HubTake) => Promise<HubTaken>;
    /** Reads the hub again, after a press changed what it says. */
    readonly hubChanged: () => Promise<void>;
    /** Reads the cards and the model accounts again, after a take made one of them here. */
    readonly connectionsChanged: () => Promise<void>;
}

// How often the hub is read while a take waits for the person at the computer: their yes is not pushed here, and what it
// makes shows up only on the next read.
const WAITING_POLL_MS = 5_000;

const SANDBOX_HUB_WIRE: HubWire = {
    // A computed rather than a function of the query: a function is asked only when a read lands, and the take's own read
    // of the hub lands before its answer says it waits.
    read: (enabled, polling) => useSandboxQuery({ ...rpcQuery(`hub.state`), enabled, refetchInterval: computed(() => (polling.value ? WAITING_POLL_MS : false)) }).query,
    save: (input) => sandboxRpc.hub.save(input),
    take: (input) => sandboxRpc.hub.take(input),
    hubChanged: () => queryClient.invalidateQueries({ queryKey: rpcKey(`hub.state`) }),
    connectionsChanged: async () => {
        await Promise.all([queryClient.invalidateQueries({ queryKey: capabilitiesKey }), refreshConnections()]);
    },
};

const SAVES = `connections-hub/save`;
const TAKES = `connections-hub/take`;

/** One take as its surface draws it: the press running, the computer's answer once it came, or why it was refused. */
export interface TakeView {
    readonly busy: boolean;
    readonly answer: HubTaken | undefined;
    readonly failure: NoticeModel | undefined;
}

/**
 * The hub for one surface. `relevant` says whether it offers the hub at all (a tile of a kind that travels, a provider
 * whose accounts do), so a surface that never will does not ask. It is the operating tier's: anyone below it is offered
 * nothing and never asks, and neither does a sandbox too old to have it.
 */
export const useConnectionHub = (relevant: MaybeRefOrGetter<boolean> = true, wire: HubWire = SANDBOX_HUB_WIRE) => {
    const { canShip } = useRole();
    const enabled = computed(() => toValue(relevant) && canShip.value && supportsRoute(`hub.state`));
    const saves = useOperations<HubSaved>(SAVES);
    const takes = useOperations<HubTaken>(TAKES);
    // A take the computer answered with "waiting": the person's yes there makes the connection later, by the sandbox.
    const waiting = computed(() => takes.all.value.some((run) => run.state === `done` && run.value?.outcome === `waiting`));
    const read = wire.read(enabled, waiting);
    const state = computed(() => (enabled.value ? read.data.value : undefined));
    const ready = computed(() => readyComputers(state.value));
    // Once that yes came, the hub lists one more connection made from it: the cards and accounts are read again, so it is
    // listed where it belongs without a reload.
    watch(
        () => state.value?.holdings.filter((holding) => holding.from !== undefined).length,
        (now, before) => {
            if (waiting.value && now !== undefined && before !== undefined && now > before) {
                void wire.connectionsChanged();
            }
        },
    );

    const save = async (target: HubTarget, machine: string): Promise<void> => {
        const sub = targetKey(target);
        if (saves.at(sub)?.state === `running`) {
            return;
        }
        saves.dismiss(sub);
        await saves.run(sub, {
            what: t(`sandbox.connectionHub.saving`, { machine }),
            failed: t(`sandbox.connectionHub.couldntSave`, { machine }),
            // Its row says how it went (Saved to …, Waits for your yes on …), read off the hub once it answers.
            quiet: true,
            task: async () => {
                const saved = await wire.save({ target, machine });
                await wire.hubChanged();
                return saved;
            },
        });
    };

    const take = async (want: HubWant): Promise<void> => {
        const sub = wantKey(want);
        if (takes.at(sub)?.state === `running`) {
            return;
        }
        takes.dismiss(sub);
        await takes.run(sub, {
            what: t(`sandbox.connectionHub.taking`),
            failed: t(`sandbox.connectionHub.couldntTake`),
            quiet: true,
            task: async () => {
                const taken = await wire.take({ want });
                // Only a take that made something here changes the lists; one still waiting is made later, by the sandbox.
                await Promise.all([wire.hubChanged(), ...(taken.outcome === `taken` ? [wire.connectionsChanged()] : [])]);
                return taken;
            },
        });
    };

    return {
        /** Some computer could take a connection in now: the only time the hub is offered. */
        offered: computed(() => ready.value.length > 0),
        /** What a card's or account's row shows of the hub; while a save of it is on its way, its note says so. */
        rowOf: (target: HubTarget): HubRowView => {
            const run = saves.at(targetKey(target));
            const busy = run?.state === `running`;
            return { saveTo: saveTargets(holdingOf(state.value, target), ready.value), note: busy ? run.what : hubNote(holdingOf(state.value, target)), busy };
        },
        /** Why the newest save of any of these was refused, for the surface listing them. */
        saveFailure: (targets: readonly HubTarget[]): NoticeModel | undefined =>
            targets
                .map((target) => saves.at(targetKey(target)))
                .filter((run) => run?.state === `failed`)
                .toSorted((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
                .at(-1)?.failure,
        dismissSaves: (targets: readonly HubTarget[]): void => {
            for (const target of targets) {
                saves.dismiss(targetKey(target));
            }
        },
        save,
        take,
        takeOf: (want: HubWant): TakeView => {
            const run = takes.at(wantKey(want));
            return { busy: run?.state === `running`, answer: run?.state === `done` ? run.value : undefined, failure: run?.failure };
        },
        dismissTake: (want: HubWant): void => takes.dismiss(wantKey(want)),
    };
};
