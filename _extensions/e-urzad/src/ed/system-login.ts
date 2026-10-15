import { createPrivateKey, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { SignJWT } from "jose";
import { type AccessToken, endpoint, type Fetch, httpsUrl, request, tokenFrom } from "../core/http.js";

// e-Doręczenia's system login (the INT integration instruction v1.9.7 and the EZD-class PROD instruction v1.9, both on
// gov.pl; the PROD realm's /.well-known/openid-configuration): OAuth 2 client_credentials with an RFC 7523 signed-JWT
// client assertion, against the Keycloak realm EDOR.
//   POST <token URL>?login_hint=ADE.<ADE>
//   grant_type=client_credentials
//   client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
//   client_assertion=<JWT: iss = sub = "<ADE>.SYSTEM.<system name>", aud = the realm URL, iat, nbf, exp, jti>
// signed with the private key of the X.509 certificate registered for the system in Moduł uprawnień (RS256 in the
// documented sample; the realm also accepts ES256/384/512 for an EC certificate). The token lives 300 s, with no
// refresh token, and the instruction asks clients not to fetch a new one while it is valid.

export type EdEnvironment = "INT" | "PROD";

export interface EdSettings {
    readonly card: string;
    readonly environment: EdEnvironment;
    readonly ade: string;
    readonly systemName: string;
    readonly certificate: string;
    readonly privateKey: string;
    readonly uaUrl: string;
    readonly seUrl: string;
    readonly tokenUrl: string;
    readonly audience: string;
}

// The documented addresses per environment (gov.pl "Interfejsy API" page and the two instructions).
export const ENVIRONMENTS = {
    INT: { iam: "https://int-ow.edoreczenia.gov.pl", ua: "https://uaapi-int-ow.poczta-polska.pl/api/v3", se: "https://int-ow.edoreczenia.gov.pl/api/se/v4" },
    PROD: { iam: "https://ow.edoreczenia.gov.pl", ua: "https://uaapi-ow.poczta-polska.pl/api/v3", se: "https://ow.edoreczenia.gov.pl/api/se/v4" },
} as const satisfies Readonly<Record<EdEnvironment, { readonly iam: string; readonly ua: string; readonly se: string }>>;

const REALM_PATH = "/auth/realms/EDOR";

// The card's environment field holds the IAM origin (so the card's own Test can probe that realm); "INT"/"PROD" are
// accepted too.
const environmentOf = (value: string): EdEnvironment => {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (trimmed === "INT" || trimmed === ENVIRONMENTS.INT.iam) {
        return "INT";
    }
    if (trimmed === "PROD" || trimmed === ENVIRONMENTS.PROD.iam) {
        return "PROD";
    }
    throw new Error(`the card's environment must be INT or PROD, not "${value}"`);
};

export interface EdCardValues {
    readonly card: string;
    readonly environment: string;
    readonly ade: string;
    readonly systemName: string;
    readonly certificate: string;
    readonly privateKey: string;
    readonly uaUrl?: string | undefined;
    readonly seUrl?: string | undefined;
    readonly tokenUrl?: string | undefined;
    readonly audience?: string | undefined;
}

const given = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());

export const edSettings = (values: EdCardValues): EdSettings => {
    const environment = environmentOf(values.environment);
    const defaults = ENVIRONMENTS[environment];
    const missing = (["ade", "systemName", "certificate", "privateKey"] as const).filter((key) => values[key].trim() === "");
    if (missing.length > 0) {
        throw new Error(`the e-Doręczenia card "${values.card}" is missing ${missing.join(", ")}`);
    }
    return {
        card: values.card,
        environment,
        ade: values.ade.trim(),
        systemName: values.systemName.trim(),
        certificate: values.certificate,
        privateKey: values.privateKey,
        uaUrl: httpsUrl(given(values.uaUrl) ?? defaults.ua, "UA API address").href.replace(/\/+$/, ""),
        seUrl: httpsUrl(given(values.seUrl) ?? defaults.se, "SE API address").href.replace(/\/+$/, ""),
        tokenUrl: httpsUrl(given(values.tokenUrl) ?? `${defaults.iam}${REALM_PATH}/protocol/openid-connect/token`, "token address").href,
        audience: given(values.audience) ?? `${defaults.iam}${REALM_PATH}`,
    };
};

const systemIdentity = (settings: Pick<EdSettings, "ade" | "systemName">): string => `${settings.ade}.SYSTEM.${settings.systemName}`;

const signingAlgorithm = (key: ReturnType<typeof createPrivateKey>): string => {
    if (key.asymmetricKeyType === "rsa") {
        return "RS256";
    }
    if (key.asymmetricKeyType === "ec") {
        const curve = key.asymmetricKeyDetails?.namedCurve;
        const algorithm = curve === "prime256v1" ? "ES256" : curve === "secp384r1" ? "ES384" : curve === "secp521r1" ? "ES512" : undefined;
        if (algorithm !== undefined) {
            return algorithm;
        }
    }
    throw new Error(`the system key is ${key.asymmetricKeyType ?? "of an unknown type"}; e-Doręczenia takes RSA or EC P-256/384/521`);
};

// The signed client assertion. Checks first that the key belongs to the certificate and the certificate is in date,
// since IAM's answer to either mistake is a bare 401.
const clientAssertion = async (settings: EdSettings, now: Date): Promise<string> => {
    const certificate = new X509Certificate(settings.certificate);
    const key = createPrivateKey(settings.privateKey);
    if (!certificate.checkPrivateKey(key) || createPublicKey(key).export({ format: "der", type: "spki" }).compare(certificate.publicKey.export({ format: "der", type: "spki" })) !== 0) {
        throw new Error("the card's private key does not belong to its certificate");
    }
    if (now.getTime() < Date.parse(certificate.validFrom) || now.getTime() > Date.parse(certificate.validTo)) {
        throw new Error(`the system certificate is valid ${certificate.validFrom} – ${certificate.validTo}, not now`);
    }
    const identity = systemIdentity(settings);
    const seconds = Math.floor(now.getTime() / 1000);
    return new SignJWT({})
        .setProtectedHeader({ alg: signingAlgorithm(key), typ: "JWT" })
        .setIssuer(identity)
        .setSubject(identity)
        .setAudience(settings.audience)
        .setIssuedAt(seconds)
        .setNotBefore(seconds)
        .setExpirationTime(seconds + 120)
        .setJti(randomUUID())
        .sign(key);
};

export const systemToken = async (settings: EdSettings, fetcher: Fetch, now: Date): Promise<AccessToken> => {
    const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await clientAssertion(settings, now),
    });
    const url = new URL(endpoint(settings.tokenUrl, [], { login_hint: `ADE.${settings.ade}` }));
    const response = await request(fetcher, url.href, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form }, { quoteErrors: false });
    return tokenFrom(response, now.getTime());
};
