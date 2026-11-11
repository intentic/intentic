import { z } from "zod";

// The parts of a capability card whose answer is not a typed string: a reference to another connection, a key the
// sandbox makes, and the test of a service that is not spoken to over HTTP. Their own module, so the card schema in
// capabilities.ts stays readable.

// (2026-11-11) A reference to another of the owner's connections, picked rather than typed: a typed name only ever minted
// references to nothing. The value stored is the connection's name, exactly what a typed one was.
export const ConnectionRefSchema = z
    .object({
        kind: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("The kind of connection it names: `device`, `exit`, `identity`, `cli`."),
        provider: z
            .string()
            .min(1)
            .optional()
            .describe("For a kind several cards share, the card it was added from: a cli card's `provider` (`imap`), a site's `platform`."),
    })
    .describe(
        "Answer this field by picking one of the owner's existing connections of this kind, by name, instead of typing the name. The empty choice is what leaving the field empty means, labelled with `placeholder`; with none of that kind connected, the field says so. The value stored is the connection's name, and the sandbox refuses a name that is not one.",
    );
export type ConnectionRef = z.infer<typeof ConnectionRefSchema>;

// The subject attributes a certificate request may carry, in the order a request writes them.
export const KEY_REQUEST_ATTRIBUTES = ["C", "ST", "L", "O", "OU", "CN", "emailAddress"] as const;
export type KeyRequestAttribute = (typeof KEY_REQUEST_ATTRIBUTES)[number];

// (2026-11-11) A key the sandbox makes and keeps, with only its certificate request shown, as an ssh card's generated key
// shows only its public half.
export const KeyRequestSchema = z
    .object({
        subject: z
            .partialRecord(z.enum(KEY_REQUEST_ATTRIBUTES), z.string())
            .describe(
                "The request's subject, attribute by attribute, as templates over the other fields (`${organization}`). An attribute that comes out empty is left out; letters with diacritics are written without them.",
            ),
        request: z
            .string()
            .optional()
            .describe(
                "A non-secret `multiline` field the request itself is kept in, so the card shows it again later; the form draws it inside this one rather than as a box of its own.",
            ),
    })
    .describe(
        "This secret field holds a private key the sandbox generates and keeps (RSA 2048): the form shows a PKCS#10 certificate signing request for it to copy or download, and the key itself never reaches the browser. For a service that issues a certificate from a request, which the card then takes in another field.",
    );
export type KeyRequest = z.infer<typeof KeyRequestSchema>;

// (2026-11-11) The test of a service not spoken to over HTTP (a database, a mailbox), whose usual failure is the network
// between it and the sandbox: the daemon dials it as its client would and signs in where it can. Every value is a
// template over the fields, like an HTTP probe's `url`.
export const CONNECT_PROTOCOLS = ["tcp", "postgres", "mysql", "imap"] as const;
export const ConnectProbeSchema = z.object({
    connect: z
        .enum(CONNECT_PROTOCOLS)
        .describe(
            "What to dial. `tcp`: only that something accepts a connection there. `postgres` and `mysql`: sign in to the database (TLS when the server offers it, as their command-line clients do) and name the server's version. `imap`: sign in with LOGIN, over implicit TLS on 993 and STARTTLS where offered elsewhere; with no password it only checks the greeting.",
        ),
    host: z.string().min(1).describe("The host to dial, templated: `${host}`."),
    port: z.string().min(1).describe("The port, templated: `${port}`."),
    user: z.string().optional().describe("Who to sign in as, templated."),
    password: z.string().optional().describe("The password, templated."),
    database: z.string().optional().describe("The database to open, for `postgres` and `mysql`; the one a success names."),
});
export type ConnectProbe = z.infer<typeof ConnectProbeSchema>;
