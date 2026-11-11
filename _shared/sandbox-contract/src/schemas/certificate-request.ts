import { z } from "zod";
import { CapabilityKindSchema } from "./capabilities.js";

// A key the sandbox makes for a card whose service issues a certificate from a request (a field declaring `keyRequest`
// in its manifest): the form gets the request to send the issuer, and a stash marker (`stashedMarker`) for the field the
// private key goes in, the way a generated SSH key arrives. The key never reaches the browser.

// POST /capabilities/certificate-request.
export const CertificateRequestInputSchema = z.object({
    kind: CapabilityKindSchema.describe("The kind of card the key is for."),
    provider: z.string().min(1).optional().describe("For a kind several cards share, the card: a cli card's provider (`e-doreczenia`)."),
    field: z.string().min(1).describe("The field declaring `keyRequest`, which the private key goes in."),
    values: z
        .record(z.string(), z.string())
        .describe("The form's answers the request's subject is filled from (`keyRequest.subject`). Never a credential: only the fields the subject names are read."),
});
export type CertificateRequestInput = z.infer<typeof CertificateRequestInputSchema>;

export const CertificateRequestSchema = z.object({
    request: z.string().describe("The PKCS#10 certificate signing request, armored (`-----BEGIN CERTIFICATE REQUEST-----`), to send the issuer."),
    subject: z.string().describe("Its subject as the issuer reads it: `C=PL, O=…, CN=…`."),
    token: z
        .string()
        .describe(
            "Stands for the private key, which never leaves the sandbox. Sent wrapped as a marker in that field, it installs the key once, on the card it was made for; it lapses after thirty minutes.",
        ),
});
export type CertificateRequest = z.infer<typeof CertificateRequestSchema>;
