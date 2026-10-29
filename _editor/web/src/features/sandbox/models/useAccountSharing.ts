import { RAW_JSON_ROUTES } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { LinkConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { InboundLinkSummary } from "@intentic/sandbox-contract/schemas/links";
import type { BorrowedAccount, SharedAccountRef } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type MaybeRefOrGetter, ref, toValue } from "vue";
import { jsonBody } from "../../../client/sandbox/jsonBody";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxJsonAt } from "../../../client/sandbox/sandboxClient";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { refreshConnections } from "../../../models/conversations/accounts/useChat-accounts";
import { inboundLinksChanged, useInboundLinks } from "../../../models/sandbox/useInboundLinks";
import { dropAtSource, lentOn, type ShareCalls, stopLendingOn } from "./shareAccounts";

// THE WIRE behind shareAccounts.ts, and the two ends of a loan as one provider's panel draws them: what this sandbox
// borrows (and the press that stops it), and what it lends to the owner's other sandboxes (and the press that takes it
// back). The far calls go to the other sandbox under the reader's own session there, as pairing a task link does.

/** The calls a press makes on the source, by its id. */
export const farShareCalls: Pick<ShareCalls, `linksAt` | `retermAt` | `mintAt` | `revokeAt`> = {
    linksAt: async (sandboxId) => (await sandboxJsonAt(sandboxId, rawRouteUrl(`GET /system/links`), RAW_JSON_ROUTES[`GET /system/links`].output)).links,
    retermAt: async (sandboxId, linkId, terms) => {
        await sandboxJsonAt(sandboxId, rawRouteUrl(`POST /system/links/{id}`, { id: linkId }), RAW_JSON_ROUTES[`POST /system/links/{id}`].output, jsonBody(`POST`, terms));
    },
    mintAt: (sandboxId, mint) => sandboxJsonAt(sandboxId, rawRouteUrl(`POST /system/links`), RAW_JSON_ROUTES[`POST /system/links`].output, jsonBody(`POST`, mint)),
    revokeAt: async (sandboxId, linkId) => {
        await sandboxJsonAt(sandboxId, rawRouteUrl(`DELETE /system/links/{id}`, { id: linkId }), RAW_JSON_ROUTES[`DELETE /system/links/{id}`].output, {
            method: `DELETE`,
        });
    },
};

/** What the source holds and how each would come here, asked of it as the reader there. */
export const shareableAt = (sandboxId: string) => sandboxRpc.sharing.shareable(undefined, { context: { at: sandboxId } });

/** This sandbox bringing accounts in over the card it holds for the source. */
export const borrowHere: ShareCalls[`borrow`] = (ask) => sandboxRpc.sharing.borrow(ask);

/** What this sandbox borrows, for a reader who may connect things, from a daemon that has the route. */
export const useBorrowedAccounts = (enabled: MaybeRefOrGetter<boolean>) =>
    useSandboxQuery({ ...rpcQuery(`sharing.borrowed`), enabled: computed(() => toValue(enabled) && supportsRoute(`sharing.borrowed`)) });

/** After a bring or a stop: read again by every panel that draws them. */
const borrowedChanged = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`sharing.borrowed`) });

/** After accounts came in or went: the picker and every panel read them off the connection list, which has to be read again. */
export const accountsMoved = async (): Promise<void> => {
    await Promise.all([refreshConnections(), borrowedChanged()]);
};

/** The key `busy` holds while the loan of an account of this sandbox's own is being ended. */
export const lendingKey = (account: SharedAccountRef): string => `${account.provider}:${account.account ?? ``}`;

// What is lent rather than copied (account-sharing.ts in the contract): a Claude sign-in, account by account. A copied
// key is this sandbox's own once it is copied, so a link that still names one lends nothing anybody could stop; a
// translator's subscriptions are not shared at all yet.
const LENT_PROVIDERS: ReadonlySet<string> = new Set([`claude`]);

/** Whether an account of this sandbox's own is of the kind another sandbox borrows rather than copies. */
const lendable = (account: SharedAccountRef): boolean => account.account !== undefined && LENT_PROVIDERS.has(account.provider);

/** One provider panel's view of the loans it is part of, both ways, and the presses that end them. */
export const useProviderSharing = () => {
    const { canShip } = useRole();
    const { activeSandboxId } = useSandbox();
    const { capabilities } = useCapabilities();
    const { query: borrowedRead } = useBorrowedAccounts(canShip);
    const { query: linksRead } = useInboundLinks(canShip);
    const borrowed = computed<readonly BorrowedAccount[]>(() => borrowedRead.data.value?.accounts ?? []);
    const links = computed<readonly InboundLinkSummary[]>(() => linksRead.data.value ?? []);
    // The row a press is ending a loan of, by its key, and what the last such press was refused for.
    const busy = ref<string>();
    const notice = ref<NoticeModel>();

    /** Who lends a row here, when another sandbox does. */
    const borrowedFrom = (account: OauthAccount): string | undefined =>
        account.borrowedFrom?.name ?? borrowed.value.find((lent) => lent.id === account.id)?.from.name;

    /** "Lent to …" for a row of this sandbox's own, or undefined when no other sandbox borrows it. */
    const lentNote = (account: SharedAccountRef): string | undefined => {
        const names = lendable(account) ? lentOn(links.value, account).map((link) => link.label) : [];
        return names.length === 0 ? undefined : t(`connect.providerPanel.lentTo`, { names: names.join(`, `) });
    };

    // The source's id, from the loan itself or the card it came through; undefined when neither says.
    const sourceOf = (lent: BorrowedAccount): string | undefined => {
        const card = capabilities.value.find((candidate) => candidate.id === lent.card);
        const config = card === undefined ? undefined : LinkConfigSchema.partial().safeParse(card.config).data;
        return lent.from.sandboxId ?? config?.sandboxId;
    };

    /** Stops borrowing one account here, then asks the source to stop lending it, as far as this editor can reach it. */
    const stopBorrowing = async (id: string): Promise<void> => {
        if (busy.value !== undefined) {
            return;
        }
        const lent = borrowed.value.find((candidate) => candidate.id === id);
        busy.value = id;
        notice.value = undefined;
        try {
            await sandboxRpc.sharing.stop({ id });
            await accountsMoved();
        } catch (failure) {
            notice.value = noticeFrom(failure, t(`connect.providerPanel.couldntStopBorrowing`));
            return;
        } finally {
            busy.value = undefined;
        }
        const sourceId = lent === undefined ? undefined : sourceOf(lent);
        if (lent === undefined || sourceId === undefined) {
            return;
        }
        const named: SharedAccountRef = lent.remote === undefined ? { provider: lent.provider } : { provider: lent.provider, account: lent.remote };
        // The source's own link only stops lending a thing this sandbox no longer asks for: tidy, not needed for the stop.
        await dropAtSource({ sourceId, hereId: activeSandboxId.value, ref: named }, farShareCalls).catch((failure) => {
            console.warn(`models: could not take a borrowed account off its source's link`, failure);
        });
    };

    /** Takes an account off every link lending it; a link left lending nothing is revoked. */
    const stopLending = async (account: SharedAccountRef): Promise<void> => {
        if (busy.value !== undefined) {
            return;
        }
        busy.value = lendingKey(account);
        notice.value = undefined;
        try {
            await Promise.all(
                lentOn(links.value, account).map((link) => {
                    const next = stopLendingOn(link, account);
                    return `revoke` in next
                        ? sandboxRaw(`DELETE /system/links/{id}`, { params: { id: link.id } })
                        : sandboxRaw(`POST /system/links/{id}`, { params: { id: link.id }, input: next.terms });
                }),
            );
        } catch (failure) {
            notice.value = noticeFrom(failure, t(`connect.providerPanel.couldntStopLending`));
        } finally {
            busy.value = undefined;
            await inboundLinksChanged();
        }
    };

    return { borrowedFrom, lentNote, stopBorrowing, stopLending, busy, notice };
};
