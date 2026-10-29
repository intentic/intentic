import { sandboxScopeGuard, sandboxShallowRef } from "@intentic/extension-api";
import type { BorrowOutcome } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { errorMessage } from "@intentic/base/errors";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { pairableSandboxes } from "../../../components/linkPairing";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { accountsOf } from "../../../models/conversations/accounts/useChat-accounts";
import { translatorAccounts } from "../../../models/providers/providerAccounts";
import { endpointProviders } from "../../../models/providers/providerCatalog";
import { useOperation } from "../../../workbench/operations/operations";
import { bySource, type HeldHere, type OtherAccount, otherAccounts, otherKey, type SourceRead, unseen } from "./otherAccounts";
import { bringAccounts, refOf, type ShareSource } from "./shareAccounts";
import { accountsMoved, borrowHere, farShareCalls, shareableAt, useBorrowedAccounts } from "./useAccountSharing";

// THE WIRE behind otherAccounts.ts: every other sandbox of the owner's read once per visit (again after a minute), the
// list of what they hold that this one does not, and the one press that brings some of them in. Shared by the Models
// page's "From your other sandboxes" and each provider's own panel, so both read one answer and one press runs at a time.

// A sandbox that does not answer in this long is said to be unreachable rather than left reading.
const READ_TIMEOUT_MS = 12_000;
// How long an answer stands before a visit asks again.
const READ_FRESH_MS = 60_000;

// allow(module-state): what each other sandbox answered, and what a press did to each account, for this sandbox's visit
const reads = sandboxShallowRef<ReadonlyMap<string, SourceRead>>(() => new Map());
// allow(module-state): see above
const outcomes = sandboxShallowRef<ReadonlyMap<string, BorrowOutcome>>(() => new Map());

const withTimeout = <T>(call: Promise<T>, after: number, message: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), after);
        call.then(resolve, reject).finally(() => clearTimeout(timer));
    });

const put = (id: string, read: SourceRead): void => {
    reads.value = new Map([...reads.value, [id, read]]);
};

const readSource = async (source: ShareSource, timeoutWords: string): Promise<void> => {
    const current = sandboxScopeGuard();
    put(source.id, { state: `reading`, source });
    try {
        const listing = await withTimeout(shareableAt(source.id), READ_TIMEOUT_MS, timeoutWords);
        if (current()) {
            put(source.id, { state: `read`, source, listing, at: Date.now() });
        }
    } catch (failure) {
        if (current()) {
            put(
                source.id,
                failure instanceof SandboxHttpError && failure.status === 404
                    ? { state: `tooOld`, source, at: Date.now() }
                    : { state: `unreachable`, source, problem: errorMessage(failure), at: Date.now() },
            );
        }
    }
};

const ALL = `all`;

// What the owner's other sandboxes hold that this one does not, read as the page opens.
export const useOtherAccounts = () => {
    const t = useT();
    const { sandboxes, activeSandboxId } = useSandbox();
    const { canShip } = useRole();
    const { query: borrowedRead } = useBorrowedAccounts(canShip);

    // The owner's other sandboxes this editor may make a link on (linkPairing.ts), and those of theirs it cannot reach
    // at all for want of an address: stopped, or never started.
    const sources = computed<readonly ShareSource[]>(() =>
        pairableSandboxes(sandboxes.value, activeSandboxId.value).map((sandbox) => ({ id: sandbox.id, name: sandbox.name, daemonUrl: sandbox.daemonUrl })),
    );
    const offline = computed(() =>
        sandboxes.value.filter(
            (sandbox) =>
                sandbox.id !== activeSandboxId.value &&
                sandbox.removedAt === null &&
                (sandbox.daemonUrl === null || sandbox.daemonUrl === ``) &&
                (sandbox.role === `owner` || sandbox.role === `maintainer`),
        ),
    );
    // Whether this sandbox could bring anything in at all; an older daemon has no route to.
    const canBorrowHere = computed(() => supportsRoute(`sharing.borrow`));
    // Whether there is anything to say: someone who may connect things, with another sandbox of theirs.
    const relevant = computed(() => canShip.value && (sources.value.length > 0 || offline.value.length > 0));

    const refresh = (force = false): void => {
        if (!canShip.value || !canBorrowHere.value) {
            return;
        }
        const now = Date.now();
        for (const source of sources.value) {
            const read = reads.value.get(source.id);
            if (read === undefined || (read.state !== `reading` && (force || now - read.at > READ_FRESH_MS))) {
                void readSource(source, t(`connect.shareAccounts.noAnswer`));
            }
        }
    };
    watch(() => [sources.value.map((source) => source.id).join(`,`), canShip.value, canBorrowHere.value], () => refresh(), { immediate: true });

    const listed = computed<readonly SourceRead[]>(() =>
        sources.value.map((source) => reads.value.get(source.id) ?? ({ state: `reading`, source } satisfies SourceRead)),
    );
    const here = computed<HeldHere>(() => {
        const translator = translatorAccounts.value;
        return {
            borrowed: borrowedRead.data.value?.accounts ?? [],
            accountsOf: (provider) => accountsOf(provider),
            endpoints: new Set(endpointProviders.value.map((endpoint) => endpoint.id)),
            subscribed: new Set(KeyedProviderSchema.options.filter((provider) => translator[provider].length > 0)),
        };
    });

    return {
        relevant,
        canBorrowHere,
        offline,
        reading: computed(() => listed.value.some((read) => read.state === `reading`)),
        rows: computed(() => otherAccounts(listed.value, here.value, outcomes.value)),
        missed: computed(() => unseen(listed.value)),
        outcomes,
        refresh,
    };
};

interface KeyedOutcome {
    readonly key: string;
    readonly outcome: BorrowOutcome;
}

// THE PRESS, kept in the operations ledger: per source, a link over there and a card here, then the accounts brought in,
// whether or not this page stays open. One at a time across the page, tagged with the row it brings (or all of them).
export const useBringOther = () => {
    const t = useT();
    const { active, activeSandboxId, daemonUrl } = useSandbox();
    const { capabilities, add, refetch } = useCapabilities();
    const bringOp = useOperation<readonly KeyedOutcome[]>(`models/share/bring`);
    const bringing = computed(() => (bringOp.busy.value ? bringOp.operation.value?.tag : undefined));

    const bringFrom = async (source: ShareSource, rows: readonly OtherAccount[]): Promise<KeyedOutcome[]> => {
        // This sandbox's cards as they stand now, so a card saved since the page loaded is widened, not made twice.
        const cards = (await refetch()).data?.capabilities ?? capabilities.value;
        const here = { id: activeSandboxId.value, name: active.value?.name ?? t(`capabilities.linkPairing.thisSandbox`), url: daemonUrl.value };
        const answered = await bringAccounts(
            { source, here, refs: rows.map((row) => refOf(row.account)), cards },
            { ...farShareCalls, saveCard: (card) => add(card), borrow: borrowHere },
        );
        return answered.map((outcome) => ({ key: otherKey(source.id, outcome), outcome }));
    };

    const bring = async (picked: readonly OtherAccount[], tag: string = ALL): Promise<void> => {
        const groups = bySource(picked.filter((row) => row.account.mode !== `no`));
        if (bringing.value !== undefined || groups.length === 0) {
            return;
        }
        const names = groups.map((group) => group.source.name).join(`, `);
        const ended = await bringOp.run({
            what: t(`connect.shareAccounts.bringing`, { name: names }),
            tag,
            quiet: true,
            failed: t(`connect.shareAccounts.couldntBring`, { name: names }),
            task: async () => {
                const results: KeyedOutcome[] = [];
                for (const group of groups) {
                    results.push(...(await bringFrom(group.source, group.rows)));
                }
                // The picker and every panel read accounts off the connection list, which has never heard of these.
                await accountsMoved();
                return results;
            },
        });
        if (ended?.state === `done`) {
            outcomes.value = new Map([...outcomes.value, ...(ended.value ?? []).map((result) => [result.key, result.outcome] as const)]);
            bringOp.dismiss();
        }
    };

    return {
        bring,
        bringing,
        bringingAll: computed(() => bringing.value === ALL),
        notice: bringOp.failure,
        // Which row the last press was for, so a panel shows only a failure of its own.
        tag: computed(() => bringOp.operation.value?.tag),
        dismiss: () => bringOp.dismiss(),
    };
};
