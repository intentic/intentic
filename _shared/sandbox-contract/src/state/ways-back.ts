import { DEVICE_FEATURE_REACHABLE_WAYS_BACK, type DeviceFacts, deviceSupports } from "../schemas/hosts.js";
import type { RollbackTarget } from "../schemas/updates.js";
import { DEV_VERSION } from "./versions.js";

// THE WAYS BACK A SANDBOX ROW OFFERS, as the device's ic means them (2026-10-20). An ic from 2026-10-19 on lists only the
// ways back a rollback can reach (versions.rs `ways_back`) and says so in the device's features (`reachable-ways-back`,
// ic's own `ic features`): its rows are offered as they are. An older ic also listed every pin pruned outside it, each as
// a download of its version, and a dev build's version is 0.0.0, which no registry publishes: three rows of "0.0.0", none
// of which could be had. Only for such a host are the rows an older ic could not reach left out, by that ic's own rule
// (a download needs a published version), rather than every host's rows being filtered on a guess. Either way each image
// is offered once.

// A release the registry publishes an image under: a dotted version, and not the one every dev build says.
const published = (version: string | undefined): boolean => version !== undefined && /^v?\d+\.\d+\.\d+$/u.test(version) && version.replace(/^v/u, "") !== DEV_VERSION;

export const waysBack = <T extends Pick<RollbackTarget, "image" | "version" | "download">>(facts: Pick<DeviceFacts, "features"> | undefined, targets: readonly T[]): T[] => {
    const once = [...new Map(targets.map((target) => [target.image, target])).values()];
    return deviceSupports(facts, DEVICE_FEATURE_REACHABLE_WAYS_BACK) ? once : once.filter((target) => target.download !== true || published(target.version));
};
