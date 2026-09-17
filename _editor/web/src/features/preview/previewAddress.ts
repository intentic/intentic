import { probePreviewOnce } from "@intentic/ui";
import { useEndpoint } from "../sandbox/secrets/useEndpoint";
import { loopbackPreviewUrl } from "./previewLane";

// The address to frame or open a preview at, for this browser: the loopback twin when the app is on the daemon's
// loopback lane and that lane answers as this sandbox's preview proxy, else the public address as given. Kept apart
// from the pure rewrite in previewLane.ts, since this one reads the shell's endpoint state.

// One probe per loopback origin per page load, misses included: a daemon that serves no previews on its loopback lane
// (an older one) will not start to mid-session, and a hit is a hit.
const answered = new Map<string, Promise<boolean>>();

export const previewAddress = async (publicUrl: string): Promise<string> => {
    const { daemonBase, usingLocal } = useEndpoint();
    const local = loopbackPreviewUrl(publicUrl, daemonBase.value, usingLocal.value);
    if (local === undefined) {
        return publicUrl;
    }
    const origin = new URL(local).origin;
    const known = answered.get(origin) ?? probePreviewOnce(local).then((probe) => probe.outcome === `reached`);
    answered.set(origin, known);
    return (await known) ? local : publicUrl;
};
