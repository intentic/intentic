import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import type { Capability, CapabilityProbe } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ConnectProbe } from "@intentic/extension-manifest";
import { z } from "zod";
import { expandFieldTemplate, type ResolvedContribution } from "../contributions.js";

// The test of a card whose service is not spoken to over HTTP (`probe.connect` in its manifest): the daemon dials it as
// its own client would and, where it can, signs in, so a database behind pg_hba or a firewall, or a mailbox refusing the
// password, is answered on the form. Read-only: a sign-in and a one-row SELECT at most, then it hangs up. The reasons a
// dial fails are said here once, for this and the HTTP probe (probe.ts) alike.

// A probe is about reachability, not a job: no answer within this long is itself the finding.
const PROBE_TIMEOUT_MS = 10_000;

// What a failed dial carries, read once where it is caught: the code Node's sockets and the database clients name the
// failure with, and their sentence. Anything thrown that is not shaped so reads as a failure with no code.
const DialErrorSchema = z.object({ code: z.string().optional(), message: z.string().default("") }).catch({ message: "" });
export type DialError = z.infer<typeof DialErrorSchema>;
export const dialError = DialErrorSchema.parse.bind(DialErrorSchema);

// A dial's failure in the reader's terms, the same words the HTTP probe uses (probe.ts); ENOTFOUND usually means
// localhost was typed for a service outside the container.
const transportReason = ({ code, message }: DialError): string => {
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return "that host does not resolve from this sandbox";
    }
    if (code === "ECONNREFUSED") {
        return "nothing is listening there";
    }
    if (code === "ETIMEDOUT" || code === "ECONNRESET") {
        return "it did not answer in time";
    }
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
        return "no route reaches it from this sandbox: a private network the sandbox is not on, or a firewall";
    }
    if (code?.includes("CERT") === true || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return "its certificate was refused";
    }
    return message === "" ? "it failed without saying why" : message;
};

// The declaration filled in from the form's answers.
export interface DialTarget {
    readonly protocol: ConnectProbe["connect"];
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
    /** What to call the service in the answer: "PostgreSQL". */
    readonly subject: string;
}

// What a database said once signed in: its version, and the database and user it opened.
export interface DatabaseSession {
    readonly version: string;
    readonly database: string;
    readonly user: string;
}

// The clients that sign in to a database, handed in so a test can answer for one without a server.
export interface DatabaseClients {
    readonly postgres: (target: DialTarget) => Promise<DatabaseSession>;
    readonly mysql: (target: DialTarget) => Promise<DatabaseSession>;
}

const failed = (message: string): CapabilityProbe => ({ checked: true, ok: false, message });
const where = (target: DialTarget): string => `${target.host}:${target.port}`;

// Opens a connection and gives it a deadline: one that does not finish within it is destroyed, as ETIMEDOUT.
const opened = <T extends Socket>(socket: T): Promise<T> =>
    new Promise((resolve, reject) => {
        socket.setTimeout(PROBE_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
        socket.once("error", reject);
        socket.once(socket instanceof TLSSocket ? "secureConnect" : "connect", () => resolve(socket));
    });

const tcpProbe = async (target: DialTarget): Promise<CapabilityProbe> => {
    try {
        (await opened(netConnect({ host: target.host, port: target.port }))).destroy();
    } catch (error) {
        return failed(`Could not reach ${where(target)}: ${transportReason(dialError(error))}.`);
    }
    return { checked: true, ok: true, message: `Reached ${where(target)}: something accepts connections there.` };
};

// --- Databases -----------------------------------------------------------------------------------------------------

// What a database's refusal means, by the SQLSTATE PostgreSQL sends or the code MySQL's client names it with. The
// server's own sentence rides along where it says what to change (pg_hba's names the address the sandbox came from).
const databaseReason = (error: DialError): string => {
    const { code, message: said } = error;
    if (code === "28P01" || code === "ER_ACCESS_DENIED_ERROR") {
        return `the user or password was refused (${said})`;
    }
    if (code === "28000" && said.includes("pg_hba.conf")) {
        return `the server does not admit this sandbox's address: add it to pg_hba.conf, or reach the server another way (${said})`;
    }
    if (code === "ER_HOST_NOT_PRIVILEGED" || code === "ER_HOST_IS_BLOCKED") {
        return `the server does not admit this sandbox's address: grant the user from it, or reach the server another way (${said})`;
    }
    if (code === "28000" || code === "ER_DBACCESS_DENIED_ERROR") {
        return `the user was refused (${said})`;
    }
    if (code === "3D000" || code === "ER_BAD_DB_ERROR") {
        return `there is no such database (${said})`;
    }
    if (code === "53300" || code === "ER_CON_COUNT_ERROR") {
        return "the server has no connections to spare";
    }
    if (said === "timeout expired" || code === "ETIMEDOUT" || said.includes("timeout")) {
        return "it did not answer in time";
    }
    return transportReason(error);
};

const databaseProbe = async (target: DialTarget, client: (target: DialTarget) => Promise<DatabaseSession>): Promise<CapabilityProbe> => {
    let session: DatabaseSession;
    try {
        session = await client(target);
    } catch (error) {
        return failed(`Could not sign in to ${target.subject} at ${where(target)}: ${databaseReason(dialError(error))}.`);
    }
    const version = session.version.split(/[\s-]/u, 1)[0] ?? session.version;
    return {
        checked: true,
        ok: true,
        message: `Reached ${target.subject} ${version} at ${where(target)}, signed in as ${session.user} to database ${session.database}.`,
        who: session.database,
    };
};

// --- IMAP ------------------------------------------------------------------------------------------------------------

// One connection's lines as they arrive, for a conversation that waits on a tagged answer.
interface Lines {
    readonly next: () => Promise<string>;
    readonly send: (line: string) => void;
}
const linesOf = (socket: Socket): Lines => {
    let buffer = "";
    const waiting: ((line: string) => void)[] = [];
    const ready: string[] = [];
    let ended: Error | undefined;
    const fail: ((error: Error) => void)[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf("\r\n"); at !== -1; at = buffer.indexOf("\r\n")) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const taker = waiting.shift();
            if (taker === undefined) {
                ready.push(line);
            } else {
                taker(line);
            }
        }
    });
    const end = (error: Error): void => {
        ended = error;
        for (const reject of fail.splice(0)) {
            reject(error);
        }
    };
    socket.on("error", end);
    socket.on("close", () => end(Object.assign(new Error("the server closed the connection"), { code: "ECONNRESET" })));
    return {
        next: () => {
            const line = ready.shift();
            if (line !== undefined) {
                return Promise.resolve(line);
            }
            if (ended !== undefined) {
                return Promise.reject(ended);
            }
            return new Promise((resolve, reject) => {
                waiting.push(resolve);
                fail.push(reject);
            });
        },
        send: (line) => {
            socket.write(`${line}\r\n`);
        },
    };
};

// Reads to the line answering `tag`, collecting the untagged ones before it.
const answerTo = async (lines: Lines, tag: string): Promise<{ readonly status: string; readonly text: string; readonly untagged: string[] }> => {
    const untagged: string[] = [];
    for (;;) {
        const line = await lines.next();
        if (line.startsWith(`${tag} `)) {
            const [status = "", ...rest] = line.slice(tag.length + 1).split(" ");
            return { status: status.toUpperCase(), text: rest.join(" "), untagged };
        }
        untagged.push(line);
    }
};

// A quoted string, the form LOGIN takes its two arguments in; undefined for a value only a literal could carry.
const quoted = (value: string): string | undefined =>
    /^[\x20-\x7E]*$/u.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : undefined;

const startTls = (socket: Socket, host: string): Promise<TLSSocket> => opened(tlsConnect({ socket, servername: host }));

// The conversation itself, on a connection already open: the greeting, STARTTLS where offered off port 993, then LOGIN.
const imapConversation = async (target: DialTarget, first: Socket): Promise<CapabilityProbe> => {
    let socket: Socket = first;
    let lines = linesOf(socket);
    const greeting = await lines.next();
    if (!/^\* (OK|PREAUTH)\b/iu.test(greeting)) {
        return failed(`${where(target)} answered, but not as an IMAP server would: ${greeting.slice(0, 120)}`);
    }
    if (target.port !== 993) {
        lines.send("a1 CAPABILITY");
        const capabilities = (await answerTo(lines, "a1")).untagged.join(" ").toUpperCase();
        if (capabilities.includes("STARTTLS")) {
            lines.send("a2 STARTTLS");
            if ((await answerTo(lines, "a2")).status !== "OK") {
                return failed(`${where(target)} offered STARTTLS and then refused it.`);
            }
            socket.removeAllListeners("data");
            socket = await startTls(socket, target.host);
            lines = linesOf(socket);
        } else if (capabilities.includes("LOGINDISABLED")) {
            return failed(`${where(target)} allows no password sign-in on an unencrypted connection: use port 993.`);
        }
    }
    if (target.password === "") {
        socket.end();
        return { checked: true, ok: true, message: `Reached the IMAP server at ${where(target)}. With no password there was no sign-in to test.` };
    }
    const user = quoted(target.user);
    const password = quoted(target.password);
    if (user === undefined || password === undefined) {
        socket.end();
        return { checked: false, ok: false, message: `Reached the IMAP server at ${where(target)}; a sign-in with characters beyond plain ASCII is not tested from here.` };
    }
    lines.send(`a3 LOGIN ${user} ${password}`);
    const login = await answerTo(lines, "a3");
    lines.send("a4 LOGOUT");
    socket.end();
    if (login.status !== "OK") {
        return failed(`The IMAP server at ${where(target)} refused the sign-in: ${login.text || login.status}. Gmail and Outlook.com take an app password here, not the account's own.`);
    }
    return { checked: true, ok: true, message: `Reached the IMAP server at ${where(target)}, signed in as ${target.user}.`, who: target.user };
};

// 993 is implicit TLS; any other port starts plain and upgrades where STARTTLS is offered, as the IMAP card's own client does.
const imapProbe = async (target: DialTarget): Promise<CapabilityProbe> => {
    let socket: Socket;
    try {
        socket = await opened(target.port === 993 ? tlsConnect({ host: target.host, port: target.port, servername: target.host }) : netConnect({ host: target.host, port: target.port }));
    } catch (error) {
        return failed(`Could not reach ${where(target)}: ${transportReason(dialError(error))}.`);
    }
    try {
        return await imapConversation(target, socket);
    } catch (error) {
        socket.destroy();
        return failed(`The IMAP server at ${where(target)} stopped answering: ${transportReason(dialError(error))}.`);
    }
};

// Dials the target with its protocol; a port that is not one is said before anything is dialled.
export const dialProbe = async (target: DialTarget, clients: DatabaseClients): Promise<CapabilityProbe> => {
    if (target.host === "" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
        return failed(target.host === "" ? "There is no host to dial yet." : `"${target.port}" is not a port.`);
    }
    if (target.protocol === "tcp") {
        return tcpProbe(target);
    }
    if (target.protocol === "imap") {
        return imapProbe(target);
    }
    return databaseProbe(target, clients[target.protocol]);
};

// The card's `probe.connect` filled in from the form's answers, or undefined for a card whose test is not a dial. A
// password is taken as typed; every other value loses the whitespace a paste drags along.
export const dialTargetOf = (contribution: ResolvedContribution | undefined, config: Capability["config"]): DialTarget | undefined => {
    const spec = contribution?.spec;
    if (spec?.kind !== "cli" || spec.probe === undefined || !("connect" in spec.probe)) {
        return undefined;
    }
    const declared = spec.probe;
    const values = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value === undefined ? "" : String(value)]));
    const fill = (template: string | undefined): string => (template === undefined ? "" : expandFieldTemplate(template, values));
    return {
        protocol: declared.connect,
        host: fill(declared.host).trim(),
        port: Number(fill(declared.port).trim()),
        user: fill(declared.user).trim(),
        password: fill(declared.password),
        database: fill(declared.database).trim(),
        subject: spec.catalog.name,
    };
};
