import { CapabilityContributionSchema, CapabilityFieldSchema } from "./capabilities.js";

// The card shapes whose answer is not a typed string: a reference to another connection, a KEY=VALUE block as rows, a
// key the sandbox makes with its certificate request, and a test that dials a service other than over HTTP.

const cliCard = (extra: Record<string, unknown>) => ({
    id: "db",
    kind: "cli",
    catalog: { name: `DB`, description: `A database.`, category: `data` },
    fields: [
        { key: "host", label: "Host" },
        { key: "port", label: "Port", default: "5432" },
    ],
    env: { DB_HOST: "${host}" },
    skill: "skills/db/SKILL.md",
    ...extra,
});

test(`a field names the kind of connection it picks, and for a shared kind its card`, () => {
    const field = CapabilityFieldSchema.parse({ key: "mailbox", label: "Code mailbox", connection: { kind: "cli", provider: "imap" } });

    expect(field.connection).toEqual({ kind: "cli", provider: "imap" });
    expect(CapabilityFieldSchema.safeParse({ key: "via", label: "Via", connection: { kind: "Device" } }).success).toBe(false);
});

test(`a key request takes a subject over the standard attributes only, and the field it keeps its request in`, () => {
    const field = CapabilityFieldSchema.parse({
        key: "privateKey",
        label: "Key",
        secret: true,
        keyRequest: { subject: { O: "${organization}", CN: "${commonName}" }, request: "certificateRequest" },
    });

    expect(field.keyRequest).toEqual({ subject: { O: "${organization}", CN: "${commonName}" }, request: "certificateRequest" });
    expect(CapabilityFieldSchema.safeParse({ key: "k", label: "K", keyRequest: { subject: { SERIAL: "x" } } }).success).toBe(false);
    expect(CapabilityFieldSchema.parse({ key: "env", label: "Environment", keyValue: true }).keyValue).toBe(true);
});

test(`a probe either calls a URL or dials a protocol it names`, () => {
    const dialled = CapabilityContributionSchema.parse(
        cliCard({ probe: { connect: "postgres", host: "${host}", port: "${port}", user: "${user}", password: "${password}", database: "${database}" } }),
    );
    const called = CapabilityContributionSchema.parse(cliCard({ probe: { url: "https://${host}/health" } }));

    expect(dialled.kind === "cli" ? dialled.probe : undefined).toEqual({
        connect: "postgres",
        host: "${host}",
        port: "${port}",
        user: "${user}",
        password: "${password}",
        database: "${database}",
    });
    expect(called.kind === "cli" ? called.probe : undefined).toEqual({ url: "https://${host}/health" });
    expect(CapabilityContributionSchema.safeParse(cliCard({ probe: { connect: "redis", host: "${host}", port: "6379" } })).success).toBe(false);
    expect(CapabilityContributionSchema.safeParse(cliCard({ probe: { connect: "tcp", host: "${host}" } })).success).toBe(false);
});
