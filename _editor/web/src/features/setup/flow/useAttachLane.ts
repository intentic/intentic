import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { useSandbox } from "../../../client/sandbox/useSandbox";
import { normalizeDaemonUrl } from "../../../lib/daemonUrl";
import { useOperation } from "../../../workbench/operations/operations";
import { type AttachOutcome, daemonUrlProblem, ownAddressProblem, type probeDaemon } from "../setupAttach";
import type { SetupRow } from "./useSetupRow";

// Connects a sandbox that is already reachable: probes the pasted address from this browser, and records it on the
// platform only once the daemon has let this account in, so a typo cannot leave an orphan sandbox behind. A retry after
// a failed attach reuses the row the arrival created; on success, straight to the workspace. An address this account
// already lists opens that sandbox instead of being recorded a second time.

type SandboxStore = ReturnType<typeof useSandbox>;

// No Google sign-in to probe with: said as itself rather than as a failed connection.
class SignInFirst extends Error {}

export interface AttachLaneHost {
    readonly sandbox: Pick<SandboxStore, `attach` | `sandboxes`>;
    readonly row: Pick<SetupRow, `created` | `error` | `autoCreate` | `connected`>;
    // The intentic hostname minted for this row, if any: pasted back, it probes as unreachable.
    readonly minted: () => string | undefined;
    readonly getIdToken: () => Promise<string | undefined>;
    readonly probe: typeof probeDaemon;
    // Opens a sandbox this account already lists at the probed address; the page settles its own draft first.
    readonly reopen: (id: string) => Promise<void>;
}

export const useAttachLane = ({ sandbox, row, minted, getIdToken, probe, reopen }: AttachLaneHost) => {
    const { created, error } = row;
    // The press in the ledger (operations.ts), tagged with the address it probes: a probe takes up to ten seconds and a
    // bind after it more, so a reader who looks elsewhere meanwhile comes back to the same press, its refusal, or why it
    // failed. Its answer is the probe's when that was anything but ok, which the card explains.
    const attempt = useOperation<AttachOutcome | undefined>(`setup/attach`);
    // The address of a press still out, or one whose answer is still to be read, so that answer has its address beside it.
    const domain = ref(attempt.operation.value?.tag ?? ``);
    // Revealed after a `needs-token` probe; used once for the first bind, never persisted.
    const attachToken = ref(``);
    const attaching = attempt.busy;
    const attachOutcome = computed(() => attempt.value.value);
    // Why the press failed, for the line the row's own notices share; the row's notice comes first.
    const attachNotice = computed(() => error.value ?? attempt.failure.value ?? null);
    // Unfolds the WEB_ORIGIN line under a failed probe. Folded by default: a reader who never set it reads it as a
    // third thing wrong with their setup, rather than as the rarest of the three causes.
    const originHelp = ref(false);

    const normalizedDomain = computed(() => normalizeDaemonUrl(domain.value));
    // This row's own minted hostname probes as unreachable, indistinguishable from a wrong domain, so it is refused
    // before the press: the reader's way forward is the command, not a second guess at DNS.
    const ownAddress = computed(() => ownAddressProblem(domain.value, minted()));
    const domainProblem = computed(() => ownAddress.value ?? daemonUrlProblem(domain.value));

    // The sandbox this account already lists at the address, other than this row: the same daemon, not a second one.
    const listedAt = (url: string) =>
        sandbox.sandboxes.value.find(
            (entry) => entry.id !== created.value?.id && entry.daemonUrl !== null && normalizeDaemonUrl(entry.daemonUrl) === url,
        );

    // The token the daemon being attached gates its first bind on: the pasted one wins; otherwise the row's own, for a
    // daemon started from this account's own setup code.
    const connectToken = (): string | undefined => {
        const pasted = attachToken.value.trim();
        return pasted !== `` ? pasted : (created.value?.token ?? undefined);
    };

    // Records the probed address on this row, creating the row first if the arrival's create was still failing when
    // the reader switched lanes; the row's id, or undefined when there is still no row to record it on.
    const bind = async (url: string): Promise<string | undefined> => {
        if (created.value === null) {
            await row.autoCreate();
        }
        const target = created.value;
        if (target === null) {
            return undefined;
        }
        await sandbox.attach(target.id, url);
        return target.id;
    };

    // Also guarded on `ownAddress` here, not only on the button: the field submits on Enter.
    const connectDomain = async (): Promise<void> => {
        const url = normalizedDomain.value;
        if (url === undefined || attaching.value || ownAddress.value !== undefined) {
            return;
        }
        error.value = null;
        await attempt.run({
            what: t(`setup.useAttachLane.connecting`, { host: new URL(url).host }),
            tag: url,
            failed: (err) => (err instanceof SignInFirst ? noticeOf(t(`setup.useAttachLane.signInFirst`)) : noticeFrom(err, t(`setup.useAttachLane.connectFailed`))),
            // The workspace opening is the answer to one that goes through; a refusal waits on the card.
            quiet: true,
            task: async () => {
                const idToken = await getIdToken();
                if (idToken === undefined) {
                    throw new SignInFirst();
                }
                const token = connectToken();
                const outcome = await probe({ daemonUrl: url, idToken, ...(token === undefined ? {} : { connectToken: token }) });
                if (outcome.kind !== `ok`) {
                    return outcome;
                }
                // Recording it on this row too would leave two rows naming one daemon.
                const listed = listedAt(url);
                if (listed !== undefined) {
                    await reopen(listed.id);
                    return undefined;
                }
                const bound = await bind(url);
                if (bound !== undefined) {
                    // The same milestone as the provision lane's check-in: the workspace opens on this sandbox specifically.
                    await row.connected(bound, { attached: true });
                }
                return undefined;
            },
        });
    };

    // Nothing carries across a lane switch, a half-finished attach included.
    const resetAttach = (): void => {
        if (!attaching.value) {
            attempt.dismiss();
        }
        attachToken.value = ``;
    };

    // Whether this page has a press of its own to come back to: still out, or a refusal or failure not yet read.
    const attachPending = computed(() => attaching.value || attachOutcome.value !== undefined || attempt.failure.value !== undefined);

    return {
        domain,
        attachToken,
        attaching,
        attachOutcome,
        attachNotice,
        attachPending,
        originHelp,
        normalizedDomain,
        ownAddress,
        domainProblem,
        connectDomain,
        resetAttach,
    };
};
