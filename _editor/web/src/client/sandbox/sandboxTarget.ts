import type { SandboxSummary } from "@intentic/api-contract";
import { useEndpoint } from "../endpoint/useEndpoint";
import { useSandbox } from "./useSandbox";

// One immutable snapshot for one authenticated call: address and credentials read in the same tick, so a
// sandbox switch mid-request can't pair one daemon's token with another's URL.
export interface SandboxTarget {
    readonly sandboxId: string | undefined;
    readonly base: string;
    // The owner's alone (the summary carries null on a member's row): it is spent on the daemon's first-bind,
    // which is the owner's act, and a member reaches a daemon that is already bound and never asks for it.
    readonly connectToken: string | undefined;
    // Set when the platform lists this sandbox for the reader, owner or member, and so can vouch for them on it: its
    // identity assertion for any such sandbox (an account that signs in by email), and its owner ticket too where
    // `ownerTicket` says so (a hosted machine, read by its owner). Absent for an address the platform does not list.
    readonly platformVouch?: { readonly ownerTicket: boolean };
}

// How the platform can vouch for the reader of this listed sandbox: always its identity assertion, and the owner ticket
// on a hosted machine read by its owner.
const vouchFor = (sandbox: SandboxSummary | undefined): Pick<SandboxTarget, `platformVouch`> =>
    sandbox === undefined ? {} : { platformVouch: { ownerTicket: sandbox.hosted !== null && sandbox.hosted !== undefined && sandbox.role === `owner` } };

export const currentSandboxTarget = (): SandboxTarget | undefined => {
    const { active, activeSandboxId } = useSandbox();
    const { daemonBase } = useEndpoint();
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId: activeSandboxId.value, base, connectToken: active.value?.token ?? undefined, ...vouchFor(active.value) };
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
    return { sandboxId, base, connectToken: sandbox.token ?? undefined, ...vouchFor(sandbox) };
};
