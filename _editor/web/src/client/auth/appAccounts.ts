import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { desktopVersion } from "../../app/environments/desktop";
import { deviceKey, storedValue, storeValue } from "../../app/storage/browserStorage";
import { rememberedEmails } from "../directory/deviceDirectory";

// THE ACCOUNTS THIS DESKTOP APP HAS BEEN SIGNED IN AS. /setup installs a sandbox on this computer by itself only for the
// app's first account (setupArrival.ts `otherAccountHere`): a sign-in that follows another account's sign-out is
// somebody switching accounts, not somebody who just installed the app to get a sandbox. On 2026-10-21 a reader signed
// out in a folder's window, signed in as another email with no sandbox, and the app set one up on their PC unasked.
//
// A device key: it outlives the sign-out, which is the whole point. It holds a one-way fingerprint of each address
// rather than the address, since an explicit sign-out is a promise that this device stops naming the account
// (deviceDirectory.ts `forgetAccount`); a fingerprint can only say "this one again", which is all this needs.

const KEY = deviceKey(`intentic.appAccounts`);
// Enough for anyone's switching; past it the oldest is dropped, which can only make the app ask more, never less.
const MAX_REMEMBERED = 20;

const RecordSchema = z.array(z.string());

const read = (): readonly string[] => {
    const raw = storedValue(KEY);
    return raw === undefined ? [] : (parseJsonWith(raw, RecordSchema) ?? []);
};

const normalized = (email: string): string => email.trim().toLowerCase();

// A page without SubtleCrypto (an insecure context) fingerprints nothing: nothing is recorded, and the arrival falls back
// to the device directory alone.
const fingerprint = async (email: string): Promise<string | undefined> => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
        return undefined;
    }
    try {
        const digest = await subtle.digest(`SHA-256`, new TextEncoder().encode(`intentic.appAccount:${normalized(email)}`));
        return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, `0`)).join(``);
        // allow(silent-catch): a digest the platform refuses records nothing; the arrival then asks only the directory.
    } catch {
        return undefined;
    }
};

// Records the account now signed in, inside the desktop app only: a browser installs nothing by itself, so its sign-ins
// decide nothing here.
export const noteAppAccount = async (email: string): Promise<void> => {
    if (desktopVersion() === undefined) {
        return;
    }
    const mark = await fingerprint(email);
    if (mark === undefined) {
        return;
    }
    const known = read();
    if (known.includes(mark)) {
        return;
    }
    storeValue(KEY, JSON.stringify([...known, mark].slice(-MAX_REMEMBERED)));
};

// Whether an account other than this one has been signed in in this app: one this record fingerprinted, or one the
// device directory still remembers (a sign-out made from a folder's window goes through the app and leaves the
// workspace's directory as it was, and it covers an app signed in before this record existed). With no account to
// compare, there is nothing to tell a switch by, and the arrival decides as it always did.
export const otherAccountInApp = async (email: string | undefined): Promise<boolean> => {
    if (email === undefined) {
        return false;
    }
    const own = normalized(email);
    if (rememberedEmails().some((entry) => entry !== own)) {
        return true;
    }
    const mark = await fingerprint(email);
    return read().some((entry) => entry !== mark);
};
