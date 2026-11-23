import { fromEachRunner, type RunnerRoster, type RunnerSockets } from "./runner-calls.js";

/* A member's access revoked here reaches every connected runner (2026-11-23). The parent's netd already ends every view
   it carried down a runner's uplink for that member (and every runner media socket), and drops their tickets; what is
   left on a runner is the picture tokens its castd minted for their views, which `revoke` there refuses from now on
   (runner-live-wiring.ts). A runner that is away holds no live view of theirs to end, and an older one lacks the door. */
export const tellRunnersRevoked = async (
    services: { readonly runnerHub: RunnerSockets; readonly runners: RunnerRoster },
    member: string | undefined,
    warn: (runner: string, error: Error) => void,
): Promise<void> => {
    await fromEachRunner(
        services.runners,
        services.runnerHub,
        (client, signal) => client.revoke(member === undefined ? {} : { member }, { signal }),
        warn,
    );
};
