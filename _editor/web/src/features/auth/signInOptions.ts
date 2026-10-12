import type { SignInOptions } from "@intentic/api-contract";
import { apiClient } from "../../lib/useApi";

// Which ways in this platform offers, read by the sign-in screens before anybody has signed in. A platform from before
// email sign-in has no such route, and one that cannot be asked offers what every platform always has: Google alone.
export const GOOGLE_ONLY: SignInOptions = { google: true, email: false };

export const readSignInOptions = async (): Promise<SignInOptions> => {
    try {
        const options = await apiClient.me.signInOptions();
        // Never neither: a platform answering both off has nothing to sign in with, and Google is what it always had.
        return options.google || options.email ? options : GOOGLE_ONLY;
    } catch (error) {
        console.warn(`[auth] the platform could not say how to sign in; offering Google:`, error);
        return GOOGLE_ONLY;
    }
};
