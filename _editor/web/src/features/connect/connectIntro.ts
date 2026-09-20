import { definePreference } from "@intentic/ui/preference";

// Whether the early offer to connect a real model has been answered. Its own module rather than a local in the strip
// that draws it: a dismissal survives the component, and a test that cannot reset it passes for the wrong reason.
export const connectIntroDismissed = definePreference<boolean>({
    key: `ui-connect-intro-dismissed`,
    read: (raw) => raw === `true`,
    write: String,
});

// Whether the reader has stopped the small model's download. Remembered rather than held in the view, because the
// daemon reports a stopped transfer as idle — indistinguishable from never-started — so without this the next visit
// would begin again the gigabyte somebody just declined.
export const localPrefetchStopped = definePreference<boolean>({
    key: `ui-local-prefetch-stopped`,
    read: (raw) => raw === `true`,
    write: String,
});
