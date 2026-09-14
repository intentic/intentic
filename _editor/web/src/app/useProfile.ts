import { isProfile, PROFILE_STORAGE_KEY, type Profile } from "@intentic/constants";
import { storedPreference } from "@intentic/ui/preference";

// Which profile brought this browser here, written by index.html's pre-paint script from the link the reader followed
// and never changed afterwards. Read rather than held: the look and the audience it decided are already applied and
// owned by their own composables, and the only thing left to do with the id itself is hand it to the platform when a
// sandbox is composed, so that machine can seed its own half of the profile.

/** The arriving profile, or undefined for a reader who came with no opinion. `default` is an opinion: the app's own. */
export const arrivingProfile = (): Profile | undefined => {
    const stored = storedPreference(PROFILE_STORAGE_KEY);
    return isProfile(stored) ? stored : undefined;
};
