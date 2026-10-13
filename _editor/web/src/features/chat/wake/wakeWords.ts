import { t } from "@intentic/ui/i18n";
import type { Destination } from "./wakeDelivery";

/** Where words are bound, as the card and a notification say it: "New session", "Continue in Fix the build". */
export const destinationLabel = (to: Destination): string => {
    const title = to.title ?? t(`chat.wake.untitled`);
    switch (to.route.kind) {
        case `new`:
            return t(`chat.wake.toNew`);
        case `continue`:
            return t(`chat.wake.toContinue`, { title });
        case `answer`:
            return t(`chat.wake.toAnswer`, { title });
    }
};
