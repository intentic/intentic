import { createHash } from "node:crypto";
import { type AccessToken, endpoint, type Fetch, request, tokenFrom } from "../core/http.js";

// EZD RP's API-key exchange (podrecznik.ezdrp.gov.pl, "Wykorzystanie klucza API w komunikacji z EZD RP"; NASK forum
// t/5017 with working code; the instance's /.well-known/openid-configuration lists grant type api_credentials and scope
// api.ezdrp.gov.pl). A form POST to the instance's SSO at /connect/token:
//   grant_type=api_credentials, scope=api.ezdrp.gov.pl,
//   client_id = "api_" + Base64(SHA-256(UTF-8(EZD web host))),   the bare host, no scheme or slash
//   pid = business-owner entity id, aki = API key id, rt = request time,
//   akh = Base64(SHA-256(UTF-8(rt + API key value))),          rt first, no separator, standard Base64
//   uid = the EZD user to act as (optional; the key's own technical user otherwise).
// The answer is a bearer token valid 3600 s. rt must carry no fractional seconds: the forum reports invalid_grant for
// the 7-digit fraction the manual's example shows, and success with whole seconds.

export interface EzdSettings {
    readonly card: string;
    readonly apiUrl: string;
    readonly ssoUrl: string;
    readonly webHost: string;
    readonly subjectId: string;
    readonly keyId: string;
    readonly apiKey: string;
    // Sid: the EZD position (stanowisko) every call acts in. Resolved from the user's positions when the card leaves it
    // empty and the user has exactly one.
    readonly positionId?: string | undefined;
    readonly userId?: string | undefined;
}

const base64Sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64");

export const requestTime = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

// "https://ezdrp-web.example.gov.pl/" and "ezdrp-web.example.gov.pl" are the same host to the hash.
export const bareHost = (value: string): string =>
    value
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\/.*$/, "")
        .toLowerCase();

export const clientIdFor = (webHost: string): string => `api_${base64Sha256(bareHost(webHost))}`;

export const keyHash = (time: string, apiKey: string): string => base64Sha256(`${time}${apiKey}`);

const tokenForm = (settings: EzdSettings, now: Date): URLSearchParams => {
    const time = requestTime(now);
    const form = new URLSearchParams({
        grant_type: "api_credentials",
        scope: "api.ezdrp.gov.pl",
        client_id: clientIdFor(settings.webHost),
        pid: settings.subjectId.trim(),
        aki: settings.keyId.trim(),
        rt: time,
        akh: keyHash(time, settings.apiKey.trim()),
    });
    if (settings.userId !== undefined && settings.userId.trim() !== "") {
        form.set("uid", settings.userId.trim());
    }
    return form;
};

export const exchangeKey = async (settings: EzdSettings, fetcher: Fetch, now: Date): Promise<AccessToken> => {
    const response = await request(
        fetcher,
        endpoint(settings.ssoUrl, ["connect", "token"]),
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: tokenForm(settings, now) },
        // An SSO's error body can echo the request; only its status is reported.
        { quoteErrors: false },
    );
    return tokenFrom(response, now.getTime());
};
