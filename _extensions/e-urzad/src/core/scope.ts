import { z } from "zod";
import type { EdSettings } from "../ed/system-login.js";
import { bareHost, type EzdSettings } from "../ezd/key-exchange.js";

// Where an office act goes and whom it acts as, as an approved operation pins it: every card setting that decides the
// destination or the acting identity, and no credential. The approved operation carries this scope, its digest covers
// it, the approval card shows it, and the backend recomputes it from the card the daemon holds at the moment of acting
// and refuses on any difference (server/perform.ts). A summary line ("EZD RP <host> (podmiot …)") is not enough: an
// edit that keeps the host can still move the base path, the scheme, the position an EZD call acts in or the user it
// acts as, the token endpoint the key is sent to, or the mailbox and system a delivery goes out as.
//
// Left out on purpose: the API key, the private key and the certificate (credentials, or a certificate renewal that does
// not change who acts), and e-Doręczenia's SE address, which only the address-register search uses, never an act.

const EzdScopeSchema = z.object({
    service: z.literal("ezd-rp"),
    // The integrator API every call goes to, and the SSO the key is exchanged at, as full addresses.
    apiUrl: z.string(),
    ssoUrl: z.string(),
    // The host the key exchange is bound to (client_id).
    webHost: z.string(),
    // The business owner entity (pid) and the API key id (aki) the key acts as.
    subjectId: z.string(),
    keyId: z.string(),
    // The position (Sid) every call acts in and the user (uid) it acts as; null when the card leaves them to EZD.
    positionId: z.string().nullable(),
    userId: z.string().nullable(),
});

const EdScopeSchema = z.object({
    service: z.literal("e-doreczenia"),
    environment: z.string(),
    // The mailbox and the registered system a delivery goes out as.
    ade: z.string(),
    systemName: z.string(),
    // The UA API every message call goes to, and where and for whom the system signs in.
    uaUrl: z.string(),
    tokenUrl: z.string(),
    audience: z.string(),
});

export const OfficeScopeSchema = z.discriminatedUnion("service", [EzdScopeSchema, EdScopeSchema]);
export type OfficeScope = z.infer<typeof OfficeScopeSchema>;

// An address as the clients resolve it: parsed, without credentials in it and without a trailing slash on its path, so
// two spellings of one address compare equal and anything that changes where a request lands does not. Not a URL at all:
// kept as written, which compares unequal to every address.
const address = (value: string): string => {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return value.trim();
    }
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
};

const optional = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
};

export const ezdScope = (settings: EzdSettings): OfficeScope => ({
    service: "ezd-rp",
    apiUrl: address(settings.apiUrl),
    ssoUrl: address(settings.ssoUrl),
    webHost: bareHost(settings.webHost),
    subjectId: settings.subjectId.trim(),
    keyId: settings.keyId.trim(),
    positionId: optional(settings.positionId),
    userId: optional(settings.userId),
});

export const edScope = (settings: EdSettings): OfficeScope => ({
    service: "e-doreczenia",
    environment: settings.environment,
    ade: settings.ade.trim(),
    systemName: settings.systemName.trim(),
    uaUrl: address(settings.uaUrl),
    tokenUrl: address(settings.tokenUrl),
    audience: address(settings.audience),
});

// What moved between the approved scope and the card's now, one `field: "was" → "now"` each; empty when nothing did.
export const scopeChanges = (approved: OfficeScope, now: OfficeScope): string[] => {
    const before: Readonly<Record<string, string | null>> = approved;
    const after: Readonly<Record<string, string | null>> = now;
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((field) => before[field] !== after[field])
        .map((field) => `${field}: ${JSON.stringify(before[field] ?? null)} → ${JSON.stringify(after[field] ?? null)}`);
};
