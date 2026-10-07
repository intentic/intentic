import { definePreference } from "@intentic/ui/preference";

// Whether the reader has stopped the small model's download. Remembered rather than held in the view, because the
// daemon reports a stopped transfer as idle — indistinguishable from never-started — so without this the next visit
// would begin again the gigabyte somebody just declined.
export const localPrefetchStopped = definePreference<boolean>({
    key: `ui-local-prefetch-stopped`,
    read: (raw) => raw === `true`,
    write: String,
});
