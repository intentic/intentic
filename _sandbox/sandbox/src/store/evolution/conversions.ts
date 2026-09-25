import { type Conversion, type Converted, convertDocument as convertWith, type Granularity } from "@intentic/sandbox-contract/documents";
import { DEV_VERSION } from "@intentic/sandbox-contract";
import { version } from "../../version.js";

// The conversion vocabulary lives in the contract (@intentic/sandbox-contract/documents), shared with extensions'
// own stored files; the daemon adds one thing to it: wherever the build is not a release (every test and every dev
// sandbox), a conversion that is not a no-op on its own output fails the first read that reaches it, so no separate
// suite has to think of asking.
export {
    at,
    ConversionError,
    describeConversions,
    drop,
    dropAll,
    fold,
    isJsonObject,
    mapValue,
    nested,
    pinDefault,
    rename,
    retireEntries,
    retype,
    transform,
    type AtConversion,
    type Conversion,
    type ConversionChange,
    type Converted,
    type DropConversion,
    type FoldConversion,
    type Granularity,
    type JsonObject,
    type MapValueConversion,
    type PinDefaultConversion,
    type RenameConversion,
    type RetireEntriesConversion,
    type RetypeConversion,
    type TransformConversion,
} from "@intentic/sandbox-contract/documents";

const CHECK_SETTLES = version === DEV_VERSION;

export const convertDocument = (conversions: readonly Conversion[], granularity: Granularity, raw: unknown): Converted =>
    convertWith(conversions, granularity, raw, CHECK_SETTLES);
