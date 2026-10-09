import type { LocalOnboardingHost } from "@intentic/web/local-host";
import { firstTaskParts } from "./firstTask";
import { pcParts } from "./pc";

// FIRST RUN (2026-10-09), the app's half of the web's localHost.ts `LocalOnboardingHost`: this PC (its check, the download
// started at first launch, its own setup and restart; pc.ts) and the first task written while it is set up (firstTask.ts).
export const onboardingHost = (): LocalOnboardingHost => ({ ...pcParts(), ...firstTaskParts() });
