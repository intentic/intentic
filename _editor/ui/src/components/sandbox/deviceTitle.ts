import type { DeviceFolderRow, DeviceSandboxGroup, DeviceSandboxRow } from "./deviceDetail.js";
import { runnerName } from "./deviceRunner.js";

// What a card on a machine's sandbox list is called (deviceDetail.ts `sandboxGroups`).

// Most-human-first: a recorded display name (the container's, else the pairing's), then the synced folder's own leaf, then
// the raw id. The exact id survives as `subtitle` rather than being replaced, since it's the string somebody actually types.
const leafOf = (dir: string | undefined): string | undefined => {
    const trimmed = (dir ?? ``).replace(/[/\\]+$/, ``);
    const leaf = trimmed.slice(Math.max(trimmed.lastIndexOf(`/`), trimmed.lastIndexOf(`\\`)) + 1);
    // A drive root (`C:\`) leaves something shaped like a name but meaning nothing about this sandbox.
    return leaf === `` || leaf.endsWith(`:`) ? undefined : leaf;
};

export const titled = (
    exact: string,
    sandbox: DeviceSandboxRow | undefined,
    folder: DeviceFolderRow | undefined,
): Pick<DeviceSandboxGroup, `title` | `subtitle`> => {
    const title = sandbox?.name ?? folder?.name ?? leafOf(folder?.localDir) ?? runnerName(sandbox) ?? exact;
    if (title === exact) {
        return { title };
    }
    return { title, subtitle: exact };
};

/** Nothing named it (no recorded name, no folder to take one from): its title is the raw id, and a card says it has none. */
export const isUntitled = (group: DeviceSandboxGroup): boolean => group.subtitle === undefined && group.sandbox?.name === undefined && group.folder === undefined;
