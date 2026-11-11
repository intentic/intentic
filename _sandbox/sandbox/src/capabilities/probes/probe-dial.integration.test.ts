import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { CapabilityContributionSchema, type ConnectProbe } from "@intentic/extension-manifest";
import type { ResolvedContribution } from "../contributions.js";
import { probeCapability } from "../probe.js";
import type { DatabaseClients } from "./probe-dial.js";
import { DATABASE_CLIENTS } from "./probe-databases.js";

// A card whose service is not spoken to over HTTP declares `probe.connect`, and the daemon dials it as its client would.
// Against real loopback servers speaking just enough of each protocol, since what a refusal looks like on the wire (an
// ErrorResponse before authentication, an IMAP NO, a closed port) is the server's fact, not ours.

const servers: Server[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

const listen = async (onSocket: (socket: Socket) => void): Promise<number> => {
    const server = createServer(onSocket);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo, never a pipe's path.
    return (server.address() as AddressInfo).port;
};

const registry = (provider: string, name: string, probe: ConnectProbe): Map<string, ResolvedContribution> => {
    const spec = CapabilityContributionSchema.parse({
        id: provider,
        kind: "cli",
        catalog: { name, description: "A service.", category: "data" },
        fields: [{ key: "host", label: "Host" }],
        env: {},
        skill: "SKILL.md",
        probe,
    });
    // SAFETY: the probe reads only the card; the extension's other facts are never looked at.
    const extension = { id: "connectors", dir: "/tmp" } as ResolvedContribution["extension"];
    return new Map([[`cli:${provider}`, { spec, extension }]]);
};

const DIAL = { host: "${host}", port: "${port}", user: "${user}", password: "${password}", database: "${database}" };
const config = (provider: string, port: number, extra: Record<string, string> = {}) => ({
    provider,
    host: "127.0.0.1",
    port: String(port),
    user: "app",
    password: "right",
    database: "app",
    ...extra,
});

test(`a tcp test says whether anything accepts connections there`, async () => {
    const port = await listen((socket) => socket.end());
    const cards = registry("box", "Box", { connect: "tcp", host: "${host}", port: "${port}" });

    const open = await probeCapability(cards, { id: "box", kind: "cli", config: config("box", port) });
    // Port 1 on loopback refuses at once.
    const closed = await probeCapability(cards, { id: "box", kind: "cli", config: config("box", 1) });
    const notAPort = await probeCapability(cards, { id: "box", kind: "cli", config: config("box", 1, { port: "70000" }) });

    expect(open).toEqual({ checked: true, ok: true, message: `Reached 127.0.0.1:${port}: something accepts connections there.` });
    expect(closed).toEqual({ checked: true, ok: false, message: "Could not reach 127.0.0.1:1: nothing is listening there." });
    expect(notAPort).toEqual({ checked: true, ok: false, message: `"70000" is not a port.` });
});

// An IMAP server that takes `ann`/`right`, offering no STARTTLS on its plain port.
const imapServer = (): Promise<number> =>
    listen((socket) => {
        socket.write("* OK IMAP4rev1 ready\r\n");
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            for (let at = buffer.indexOf("\r\n"); at !== -1; at = buffer.indexOf("\r\n")) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                const [tag, command] = line.split(" ");
                if (command === "CAPABILITY") {
                    socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
                } else if (command === "LOGIN") {
                    socket.write(line === `${tag} LOGIN "ann" "right"` ? `${tag} OK LOGIN completed\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
                } else if (command === "LOGOUT") {
                    socket.end(`* BYE\r\n${tag} OK\r\n`);
                }
            }
        });
    });

test(`an IMAP test signs in with LOGIN, and says the server's own refusal`, async () => {
    const port = await imapServer();
    const cards = registry("imap", "IMAP", { connect: "imap", host: "${host}", port: "${port}", user: "${username}", password: "${password}" });

    const right = await probeCapability(cards, { id: "imap", kind: "cli", config: { provider: "imap", host: "127.0.0.1", port: String(port), username: "ann", password: "right" } });
    const wrong = await probeCapability(cards, { id: "imap", kind: "cli", config: { provider: "imap", host: "127.0.0.1", port: String(port), username: "ann", password: "wrong" } });
    // No password (a card signing in with OAuth2): only the greeting is tested.
    const none = await probeCapability(cards, { id: "imap", kind: "cli", config: { provider: "imap", host: "127.0.0.1", port: String(port), username: "ann" } });

    expect(right).toEqual({ checked: true, ok: true, message: `Reached the IMAP server at 127.0.0.1:${port}, signed in as ann.`, who: "ann" });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toBe(
        `The IMAP server at 127.0.0.1:${port} refused the sign-in: [AUTHENTICATIONFAILED] Invalid credentials. Gmail and Outlook.com take an app password here, not the account's own.`,
    );
    expect(none).toEqual({ checked: true, ok: true, message: `Reached the IMAP server at 127.0.0.1:${port}. With no password there was no sign-in to test.` });
});

// --- PostgreSQL, through the real pg client -------------------------------------------------------------------------

const SSL_REQUEST = 80_877_103;
const message = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeInt32BE(body.length + 4);
    return Buffer.concat([Buffer.from(type), length, body]);
};
const cstrings = (...values: string[]): Buffer => Buffer.concat(values.map((value) => Buffer.from(`${value}\0`)));
const int32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value);
    return bytes;
};
const int16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    bytes.writeInt16BE(value);
    return bytes;
};
const refusal = (code: string, text: string): Buffer => message("E", Buffer.concat([cstrings(`SFATAL`, `VFATAL`, `C${code}`, `M${text}`), Buffer.from([0])]));
const rows = (row: Record<string, string>): Buffer => {
    const names = Object.keys(row);
    const description = Buffer.concat([
        int16(names.length),
        ...names.map((name) => Buffer.concat([cstrings(name), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)])),
    ]);
    const data = Buffer.concat([int16(names.length), ...Object.values(row).map((value) => Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]))]);
    return Buffer.concat([message("T", description), message("D", data), message("C", cstrings("SELECT 1")), message("Z", Buffer.from("I"))]);
};

// A server with no TLS to offer that answers a startup with `startup`, then (once signed in) every query with one row.
const postgresServer = (startup: (password: boolean) => Buffer): Promise<number> =>
    listen((socket) => {
        let started = false;
        socket.on("data", (chunk: Buffer) => {
            if (!started && chunk.length === 8 && chunk.readInt32BE(4) === SSL_REQUEST) {
                socket.write("N");
                return;
            }
            if (!started) {
                started = true;
                socket.write(startup(false));
                return;
            }
            if (chunk[0] === "p".charCodeAt(0)) {
                socket.write(Buffer.concat([message("R", int32(0)), message("Z", Buffer.from("I"))]));
            } else if (chunk[0] === "Q".charCodeAt(0)) {
                socket.write(rows({ version: "16.4 (Debian 16.4-1)", database: "app", user: "app_ro" }));
            } else if (chunk[0] === "X".charCodeAt(0)) {
                socket.end();
            }
        });
    });

test(`a PostgreSQL test signs in through TLS when offered, plain when not, and names the server's version and database`, async () => {
    const port = await postgresServer(() => message("R", int32(3)));
    const cards = registry("postgres", "PostgreSQL", { connect: "postgres", ...DIAL });

    const answer = await probeCapability(cards, { id: "postgres", kind: "cli", config: config("postgres", port) });

    expect(answer).toEqual({
        checked: true,
        ok: true,
        message: `Reached PostgreSQL 16.4 at 127.0.0.1:${port}, signed in as app_ro to database app.`,
        who: "app",
    });
});

test(`a PostgreSQL server that does not admit the sandbox's address says so, with its own words naming the address`, async () => {
    const said = `no pg_hba.conf entry for host "172.17.0.2", user "app", database "app", no encryption`;
    const port = await postgresServer(() => refusal("28000", said));
    const cards = registry("postgres", "PostgreSQL", { connect: "postgres", ...DIAL });

    const answer = await probeCapability(cards, { id: "postgres", kind: "cli", config: config("postgres", port) });

    expect(answer).toEqual({
        checked: true,
        ok: false,
        message: `Could not sign in to PostgreSQL at 127.0.0.1:${port}: the server does not admit this sandbox's address: add it to pg_hba.conf, or reach the server another way (${said}).`,
    });
});

// --- MySQL ------------------------------------------------------------------------------------------------------------

test(`a MySQL server that refuses the sandbox's host before its handshake is read through the real client`, async () => {
    const said = "Host '127.0.0.1' is not allowed to connect to this MySQL server";
    const payload = Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), Buffer.from(said)]);
    const header = Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, 0]);
    const port = await listen((socket) => socket.end(Buffer.concat([header, payload])));
    const cards = registry("mysql", "MySQL", { connect: "mysql", ...DIAL });

    const answer = await probeCapability(cards, { id: "mysql", kind: "cli", config: config("mysql", port) }, undefined, DATABASE_CLIENTS);

    expect(answer.ok).toBe(false);
    expect(answer.message).toBe(
        `Could not sign in to MySQL at 127.0.0.1:${port}: the server does not admit this sandbox's address: grant the user from it, or reach the server another way (${said}).`,
    );
});

// The refusals a database client names by code, said the same way for both databases.
test(`a database's refusal is said by what it means, whichever database said it`, async () => {
    const refusing = (code: string, text: string): DatabaseClients => {
        const fail = () => Promise.reject(Object.assign(new Error(text), { code }));
        return { postgres: fail, mysql: fail };
    };
    const cards = registry("mysql", "MySQL", { connect: "mysql", ...DIAL });
    const ask = (clients: DatabaseClients) => probeCapability(cards, { id: "mysql", kind: "cli", config: config("mysql", 3306) }, undefined, clients);

    expect((await ask(refusing("ER_ACCESS_DENIED_ERROR", "Access denied for user 'app'"))).message).toBe(
        "Could not sign in to MySQL at 127.0.0.1:3306: the user or password was refused (Access denied for user 'app').",
    );
    expect((await ask(refusing("ER_BAD_DB_ERROR", "Unknown database 'app'"))).message).toBe(
        "Could not sign in to MySQL at 127.0.0.1:3306: there is no such database (Unknown database 'app').",
    );
    expect((await ask(refusing("EHOSTUNREACH", "connect EHOSTUNREACH"))).message).toBe(
        "Could not sign in to MySQL at 127.0.0.1:3306: no route reaches it from this sandbox: a private network the sandbox is not on, or a firewall.",
    );
    const signedIn: DatabaseClients = { ...refusing("", ""), mysql: () => Promise.resolve({ version: "8.4.3", database: "shop", user: "app@%" }) };
    expect(await ask(signedIn)).toEqual({
        checked: true,
        ok: true,
        message: "Reached MySQL 8.4.3 at 127.0.0.1:3306, signed in as app@% to database shop.",
        who: "shop",
    });
});
