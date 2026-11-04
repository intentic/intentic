import { isProfile, type Profile, PROFILE_STORAGE_KEY, PROFILES, type SandboxMode } from "@intentic/constants";
import { storedPreference } from "@intentic/ui/preference";

// Which profile brought this browser here, written by index.html's pre-paint script from the link the reader followed
// and never changed afterwards. It decides nothing by itself (@intentic/constants profile.ts): all that is left of it is
// the answer preselected where a sandbox is made, which the reader sees and can change.

/** The arriving profile, or undefined for a reader who came with no opinion. `default` is an opinion: the app's own. */
export const arrivingProfile = (): Profile | undefined => {
    const stored = storedPreference(PROFILE_STORAGE_KEY);
    return isProfile(stored) ? stored : undefined;
};

/** How the arriving profile would have a new sandbox run, preselected in "Who handles the code here?". */
export const arrivingMode = (): SandboxMode | undefined => {
    const profile = arrivingProfile();
    return profile === undefined ? undefined : PROFILES[profile].mode;
};

// THE DESKTOP APP'S SPELLING OF THE ANSWER. A setup link carries `profile` to the app, which re-mints a code with it when
// the first one ran out (src-tauri project.rs `mint_ask`); the platform reads `desk` there as hands-off. So the app,
// which predates the mode, still seeds a hands-off sandbox it finishes setting up.
export const profileForMode = (mode: SandboxMode | undefined): Profile | undefined => (mode === `hands-off` ? `desk` : undefined);
