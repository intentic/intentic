import type { GroupSamples } from "./context.ts";

// A Claude paste sign-in from start to finish: started, read while it waits, completed with the pasted code (landing
// the provider's first new account, `acc_claude_1`), cancelled, and that account disconnected again, so the list ends
// as it began.
export const accountsSamples: GroupSamples<`accounts`> = () => ({
    accounts: { provider: `claude` },
    start: { provider: `claude` },
    status: { provider: `claude`, handshake: `demo-handshake-claude-1` },
    complete: { provider: `claude`, handshake: `demo-handshake-claude-1`, code: `smoke` },
    cancel: { provider: `claude`, handshake: `demo-handshake-claude-1` },
    rename: { provider: `claude`, id: `acc_claude_demo`, label: `Claude Max` },
    disconnect: { provider: `claude`, id: `acc_claude_1` },
});
