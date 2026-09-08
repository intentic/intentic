import type { SandboxSummary } from "@intentic/api-contract";
import { useEndpoint } from "../secrets/useEndpoint";
import { useSandbox } from "./useSandbox";

// One immutable snapshot for one authenticated call: address and credentials read in the same tick, so a
// sandbox switch mid-request can't pair one daemon's token with another's URL.
export interface SandboxTarget {
    readonly sandboxId: string | undefined;
    readonly base: string;
    // The owner's alone (the summary carries null on a member's row): it is spent on the daemon's first-bind,
    // which is the owner's act, and a member reaches a daemon that is already bound and never asks for it.
    readonly connectToken: string | undefined;
    // Set when the platform can vouch for this reader via a signed ticket instead of Google; absent otherwise.
    readonly ownerVouched?: true;
}

// Whether the platform's owner ticket applies: a hosted machine, read by its owner.
const vouchedFor = (sandbox: SandboxSummary | undefined): { readonly ownerVouched: true } | Record<never, never> =>
    sandbox !== undefined && sandbox.hosted !== null && sandbox.hosted !== undefined && sandbox.role === `owner` ? { ownerVouched: true } : {};

export const currentSandboxTarget = (): SandboxTarget | undefined => {
    const { active, activeSandboxId } = useSandbox();
    const { daemonBase } = useEndpoint();
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId: activeSandboxId.value, base, connectToken: active.value?.token ?? undefined, ...vouchedFor(active.value) };
};

// Addresses a sandbox this browser may not be pointed at, always via the tunnel (never probing for a loopback
// shortcut, which would cost every candidate a probe and a permission prompt). The active sandbox still
// delegates to its own resolved target.
export const targetFor = (sandboxId: string): SandboxTarget | undefined => {
    const { sandboxes, activeSandboxId } = useSandbox();
    if (sandboxId === activeSandboxId.value) {
        return currentSandboxTarget();
    }
    const sandbox = sandboxes.value.find((entry) => entry.id === sandboxId);
    const base = sandbox?.daemonUrl;
    if (sandbox === undefined || base === null || base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId, base, connectToken: sandbox.token ?? undefined, ...vouchedFor(sandbox) };
};
