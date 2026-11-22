import { GIB, historySpaceFloor, type HistorySpace } from "../../../system/resources/storage/checkout-space.js";

export interface FanOutCostFacts {
    readonly bytes: number;
    readonly space: HistorySpace;
    readonly largestFolders: readonly { readonly path: string; readonly bytes: number }[];
    readonly pathsGiven: boolean;
}

const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

/** A short admission heads-up, only when each first checkout is a material share of the disk. */
export const fanOutCostNote = ({ bytes, space, largestFolders, pathsGiven }: FanOutCostFacts): string | undefined => {
    const aboveFloor = Math.max(0, space.freeBytes - historySpaceFloor(space.totalBytes));
    if (bytes < GIB && bytes <= aboveFloor * 0.05) {
        return undefined;
    }
    const atOnce = bytes <= 0 ? 0 : Math.floor(aboveFloor / bytes);
    const folders = largestFolders.length === 0 ? "" : ` Largest folders: ${largestFolders.map(({ path, bytes: size }) => `${path} ${gb(size)}`).join(", ")}.`;
    const advice = pathsGiven ? "" : " Pass `paths` to check out only what each one needs.";
    return `Each subagent here checks out about ${gb(bytes)}; the disk has room for about ${atOnce} at once (${gb(aboveFloor)} free above its floor), and the rest wait for disk space.${folders}${advice}`;
};
