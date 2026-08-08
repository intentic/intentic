import { useEndpoint } from "./useEndpoint";
import { useSandbox } from "./useSandbox";

// One immutable destination for one authenticated operation. Both the address and its credentials are read in
// the same tick, so switching sandboxes while Google/session work is awaiting cannot pair one daemon's token
// with another daemon's URL or connect secret.
export interface SandboxTarget {
    readonly sandboxId: string | undefined;
    readonly base: string;
    readonly connectToken: string | undefined;
}

export const currentSandboxTarget = (): SandboxTarget | undefined => {
    const { active, activeSandboxId } = useSandbox();
    const { daemonBase } = useEndpoint();
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId: activeSandboxId.value, base, connectToken: active.value?.token };
};
