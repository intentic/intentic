import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import {
    IntenticOsDisplayListSchema,
    IntenticOsDriveImportProgressSchema,
    IntenticOsDriveImportSchema,
    IntenticOsDrivesSchema,
    IntenticOsKeyboardLayoutsSchema,
    IntenticOsKeyboardStatusSchema,
    IntenticOsNetworkStatusSchema,
    IntenticOsSoundOutputsSchema,
    IntenticOsSoundStatusSchema,
    IntenticOsWifiListSchema,
} from "@intentic/sandbox-contract/schemas/intentic-os";

// The contract's examples of what `ic os` prints for this computer's settings (_shared/sandbox-contract/golden/
// intentic-os.json), read through the contract's own schemas: what the app's os_settings.rs reads field for field, and
// what This computer's cards are tested against.

/** The golden's lists this module reads, each still to be read through its schema. */
interface Golden {
    readonly networkStatus: unknown;
    readonly wifiList: unknown;
    readonly soundStatus: unknown;
    readonly soundOutputs: unknown;
    readonly displayList: unknown;
    readonly keyboardStatus: unknown;
    readonly keyboardLayouts: unknown;
    readonly drives: unknown;
    readonly driveImportProgress: unknown;
    readonly driveImport: unknown;
}

// SAFETY: the golden is this repository's own file; each answer is read through its schema below, which fails on any
// field it lacks.
const raw = JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_shared/sandbox-contract/golden/intentic-os.json`), `utf8`)) as Golden;

export const GOLDEN = {
    networkStatus: IntenticOsNetworkStatusSchema.array().parse(raw.networkStatus),
    wifiList: IntenticOsWifiListSchema.array().parse(raw.wifiList),
    soundStatus: IntenticOsSoundStatusSchema.array().parse(raw.soundStatus),
    soundOutputs: IntenticOsSoundOutputsSchema.array().parse(raw.soundOutputs),
    displayList: IntenticOsDisplayListSchema.array().parse(raw.displayList),
    keyboardStatus: IntenticOsKeyboardStatusSchema.array().parse(raw.keyboardStatus),
    keyboardLayouts: IntenticOsKeyboardLayoutsSchema.array().parse(raw.keyboardLayouts),
    drives: IntenticOsDrivesSchema.array().parse(raw.drives),
    driveImportProgress: IntenticOsDriveImportProgressSchema.array().parse(raw.driveImportProgress),
    driveImport: IntenticOsDriveImportSchema.array().parse(raw.driveImport),
};

/** The one example at `index` of a golden list: a test reading past the end is a test wrong about the golden. */
export const example = <T>(list: readonly T[], index = 0): T => {
    const found = list[index];
    if (found === undefined) {
        throw new Error(`the golden has no example ${index}`);
    }
    return found;
};
