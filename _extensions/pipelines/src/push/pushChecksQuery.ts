import type { PushChecks } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "../host";

// Shared read model for what pushes left (`workspace.pushChecks`): the Left at push section, the rail badge and the
// background loader read one HostQuery, so any of them fills the entry the others consume. The key is the one the
// daemon's `pushes` push invalidates (runtime-state.ts), so a push filed, a finding measured gone, a dismissal or a
// hand-over reaches an open board without its poll.
export const PUSH_CHECKS_STALE_MS = 20_000;

export const pushChecksQuery = (): HostQuery<PushChecks> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`push-checks`),
        queryFn: (): Promise<PushChecks> => api.sandbox.rpc.workspace.pushChecks(),
        staleTime: PUSH_CHECKS_STALE_MS,
    };
};
