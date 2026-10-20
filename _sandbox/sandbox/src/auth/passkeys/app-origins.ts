import type { Logger } from "pino";
import { z } from "zod";
import { allowedOriginsOf, rpIdOf } from "../browser-origins.js";

/* PASSKEYS FROM THE NATIVE ANDROID APP (2026-10-20).

A browser signs a ceremony with its page's origin; Android's Credential Manager signs one made by an app with
`android:apk-key-hash:<base64url of the SHA-256 of the app's signing certificate>`, and lets the app use the passkeys of
a site only when that site's Digital Asset Links file (`https://<rpId>/.well-known/assetlinks.json`) grants the app
`delegate_permission/common.get_login_creds`. The daemon admits such an origin by the same statement Android itself
checks: it reads the editor's own file and accepts the fingerprints it grants, for the editor's rpId, so a passkey made
in the web editor signs in from the app and the reverse. The fingerprints live in that file alone (the web image renders
it from ANDROID_APP_FINGERPRINTS at start), so a new signing key reaches every sandbox without recreating one, and a
sandbox whose editor publishes none admits no app. */

const ANDROID_ORIGIN_PREFIX = "android:apk-key-hash:";

const GET_LOGIN_CREDS = "delegate_permission/common.get_login_creds";

// What `keytool` and the Play console print: 32 bytes as colon-separated hex pairs.
const FINGERPRINT = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/;

// How long the editor's statement is believed; a fingerprint added or withdrawn there is heard within this.
const KEPT_MS = 10 * 60_000;
// After a failed read, how long the last statement read (or none) stands before the next ceremony asks again.
const RETRY_MS = 30_000;
// Under the ceremony's own wait, so a slow editor host refuses the sign-in rather than hangs it.
const FETCH_TIMEOUT_MS = 5_000;

// One statement about an Android app. Anything else a file may hold (a web target, an `include`, a malformed entry) is
// dropped as it is read, and admits nothing.
const AppStatementSchema = z.object({
    relation: z.array(z.string()),
    target: z.object({ namespace: z.literal("android_app"), sha256_cert_fingerprints: z.array(z.string()) }),
});
export type AppStatement = z.infer<typeof AppStatementSchema>;

export const AssetLinksSchema = z
    .array(z.unknown())
    .transform((entries) => entries.flatMap((entry) => AppStatementSchema.safeParse(entry).data ?? []));

// The WebAuthn origin an app signed with this certificate presents.
export const apkKeyHashOrigin = (fingerprint: string): string => `${ANDROID_ORIGIN_PREFIX}${Buffer.from(fingerprint.replaceAll(":", ""), "hex").toString("base64url")}`;

// The app origins a Digital Asset Links file lets sign in with the site's passkeys: App Links alone admit nothing.
export const appOriginsOf = (statements: readonly AppStatement[]): ReadonlySet<string> => {
    const origins = new Set<string>();
    for (const statement of statements) {
        if (!statement.relation.includes(GET_LOGIN_CREDS)) {
            continue;
        }
        for (const fingerprint of statement.target.sha256_cert_fingerprints) {
            if (FINGERPRINT.test(fingerprint)) {
                origins.add(apkKeyHashOrigin(fingerprint));
            }
        }
    }
    return origins;
};

// The rpId an app origin may sign for, or undefined when it may not.
export type AppRelyingParty = (origin: string) => Promise<string | undefined>;

export interface AppRelyingPartyDeps {
    // The daemon's `webOrigin`: its first exact https entry is the editor whose rpId and statement an app answers to.
    readonly webOrigin: string;
    readonly logger: Pick<Logger, "warn">;
    readonly fetcher?: typeof fetch;
    readonly now?: () => number;
}

export const createAppRelyingParty = ({ webOrigin, logger, fetcher = fetch, now = Date.now }: AppRelyingPartyDeps): AppRelyingParty => {
    const editor = allowedOriginsOf(webOrigin).find((origin) => origin.startsWith("https://") && !origin.includes("*"));
    if (editor === undefined) {
        return async () => undefined;
    }
    const rpId = rpIdOf(editor);
    const url = `https://${rpId}/.well-known/assetlinks.json`;
    let held: { readonly until: number; readonly origins: ReadonlySet<string> } | undefined;
    let reading: Promise<ReadonlySet<string>> | undefined;

    const read = async (): Promise<ReadonlySet<string>> => {
        // No redirect followed, as Android follows none for this file.
        const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`${url} answered ${response.status}`);
        }
        return appOriginsOf(AssetLinksSchema.parse(await response.json()));
    };

    // One read at a time, however many ceremonies ask while it runs.
    const refresh = async (): Promise<ReadonlySet<string>> => {
        try {
            const origins = await read();
            held = { until: now() + KEPT_MS, origins };
            return origins;
        } catch (error) {
            // A passing outage keeps the last statement read rather than locking every app out for it.
            logger.warn({ err: error, url }, "passkeys: could not read the editor's Digital Asset Links; app sign-in keeps what it last read");
            const origins = held?.origins ?? new Set<string>();
            held = { until: now() + RETRY_MS, origins };
            return origins;
        } finally {
            reading = undefined;
        }
    };

    const admitted = (): Promise<ReadonlySet<string>> => {
        if (held !== undefined && now() < held.until) {
            return Promise.resolve(held.origins);
        }
        reading ??= refresh();
        return reading;
    };

    return async (origin) => (origin.startsWith(ANDROID_ORIGIN_PREFIX) && (await admitted()).has(origin) ? rpId : undefined);
};
