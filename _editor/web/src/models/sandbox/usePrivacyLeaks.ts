import type { PrivacyLeakReport, PrivacyLeaks } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { rpcKey, rpcPrefix } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";

// Leaks and hardening (schemas/privacy-leaks.ts) as the privacy page and a chat's "Should have been masked" use them.
// The leaks view holds the values that leaked and the text around them, so it is read into memory only and never
// retried: a refusal (anybody who does not run the shield) does not change by asking again. Every write moves what the
// shield masks (a reported or confirmed value is taught to the vault as its own `leak:<id>` source, a dismissed one is
// forgotten), so each re-reads the leaks, the status's count of learned values and the taught sources together.

const settleLeaks = async (): Promise<void> => {
    await Promise.all([
        // Prefix, not key: the unpersisted mark sits between the procedure and the sandbox in this entry's key.
        queryClient.invalidateQueries({ queryKey: rpcPrefix(`privacy.leaks`) }),
        queryClient.invalidateQueries({ queryKey: rpcKey(`privacy.status`) }),
        queryClient.invalidateQueries({ queryKey: rpcKey(`privacy.sources`) }),
    ]);
};

// An applied proposal changes the policy too, and the dictionary and a tried text are read under it (usePrivacyShield).
const settlePolicy = async (): Promise<void> => {
    await Promise.all([
        settleLeaks(),
        queryClient.invalidateQueries({ queryKey: rpcPrefix(`privacy.dictionary`) }),
        queryClient.invalidateQueries({ queryKey: rpcPrefix(`privacy.preview`) }),
    ]);
};

// Each write resolves either way, and says whether it went: its refusal is read from its own error, beside the press.
const settled = async <T>(write: Promise<T>): Promise<T | undefined> => {
    try {
        return await write;
    } catch {
        // allow(silent-catch): the mutation keeps its own error, which the caller's notice says.
        return undefined;
    }
};

// "This should have been masked", alone: what a chat's selection sends, without reading the leaks themselves.
export function useLeakReport() {
    const report = useMutation({ mutationFn: (leak: PrivacyLeakReport) => sandboxRpc.privacy.report(leak), onSettled: settleLeaks }, queryClient);
    return {
        // The new leak's id, or undefined when it was refused (`reportError` says why).
        report: async (leak: PrivacyLeakReport): Promise<string | undefined> => (await settled(report.mutateAsync(leak)))?.id,
        reporting: computed<boolean>(() => report.isPending.value),
        reportError: computed<Error | null>(() => report.error.value),
        resetReport: (): void => report.reset(),
    };
}

export function usePrivacyLeaks() {
    const { query, loaded } = useSandboxQuery({
        ...rpcQuery(`privacy.leaks`, undefined, { unpersisted: true }),
        retry: false,
    });

    const reporting = useLeakReport();

    const judge = useMutation(
        { mutationFn: (verdict: { id: string; state: `confirmed` | `dismissed` }) => sandboxRpc.privacy.judge(verdict), onSettled: settleLeaks },
        queryClient,
    );
    const scan = useMutation({ mutationFn: () => sandboxRpc.privacy.scan({}), onSettled: settleLeaks }, queryClient);
    const apply = useMutation({ mutationFn: (id: string) => sandboxRpc.privacy.applyProposal({ id }), onSettled: settlePolicy }, queryClient);
    const dismiss = useMutation({ mutationFn: (id: string) => sandboxRpc.privacy.dismissProposal({ id }), onSettled: settleLeaks }, queryClient);
    // Only so the page offers to open the session rather than start a second one; the session runs whether or not it lands.
    const session = useMutation(
        { mutationFn: (conversationId: string) => sandboxRpc.privacy.hardeningSession({ conversationId }), onSettled: settleLeaks },
        queryClient,
    );

    return {
        leaks: computed<PrivacyLeaks | undefined>(() => query.data.value),
        loaded,
        ...reporting,
        judge: async (id: string, state: `confirmed` | `dismissed`): Promise<void> => {
            await settled(judge.mutateAsync({ id, state }));
        },
        // The leak a verdict is on its way for, so only its row waits.
        judging: computed<string | undefined>(() => (judge.isPending.value ? judge.variables.value?.id : undefined)),
        judgeError: computed<Error | null>(() => judge.error.value),
        scan: async (): Promise<void> => {
            await settled(scan.mutateAsync());
        },
        scanning: computed<boolean>(() => scan.isPending.value),
        scanned: computed(() => scan.data.value),
        scanError: computed<Error | null>(() => scan.error.value),
        applyProposal: async (id: string): Promise<void> => {
            await settled(apply.mutateAsync(id));
        },
        dismissProposal: async (id: string): Promise<void> => {
            await settled(dismiss.mutateAsync(id));
        },
        // The proposal a press is on its way for, and the last one refused with why, so each card says only its own.
        deciding: computed<string | undefined>(() =>
            apply.isPending.value ? apply.variables.value : dismiss.isPending.value ? dismiss.variables.value : undefined,
        ),
        applyError: computed(() => (apply.error.value === null ? undefined : { id: apply.variables.value, error: apply.error.value })),
        dismissError: computed(() => (dismiss.error.value === null ? undefined : { id: dismiss.variables.value, error: dismiss.error.value })),
        noteSession: async (conversationId: string): Promise<void> => {
            await settled(session.mutateAsync(conversationId));
        },
        sessionError: computed<Error | null>(() => session.error.value),
    };
}
