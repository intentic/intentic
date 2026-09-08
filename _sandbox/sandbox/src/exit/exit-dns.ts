import { connect, type Socket } from "node:net";

// Hand-rolled DNS over TCP: queries must leave from the exit's own address, and Node's resolver cannot be told a source
// address. TCP since only a TCP socket takes `localAddress`; one query per connection, no cache (the browser caches its
// own). A/AAAA only, CNAMEs followed via records the server already returned.

const DNS_PORT = 53;
const QUERY_TIMEOUT_MS = 5_000;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;

// Hostname as DNS wants it: each label length-prefixed, zero-terminated. Labels over 63 bytes are illegal and rejected
// here, not silently truncated.
export const encodeName = (host: string): Buffer => {
    const labels = host.replace(/\.$/, "").split(".");
    const parts: Buffer[] = [];
    for (const label of labels) {
        const bytes = Buffer.from(label, "utf8");
        if (bytes.length === 0 || bytes.length > 63) {
            throw new Error(`not a resolvable hostname: ${host}`);
        }
        parts.push(Buffer.from([bytes.length]), bytes);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
};

export const encodeQuery = (id: number, host: string, type: number): Buffer => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    // 0x0100 sets RD (recursion desired) only; no truncation flags, no authoritative-answer request.
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const question = Buffer.concat([encodeName(host), Buffer.alloc(4)]);
    question.writeUInt16BE(type, question.length - 4);
    question.writeUInt16BE(CLASS_IN, question.length - 2);
    return Buffer.concat([header, question]);
};

// Steps over a name at `offset`, honouring compression pointers, and returns where the record continues. Only the
// length matters, names in answers are never decoded.
export const skipName = (message: Buffer, offset: number): number => {
    let at = offset;
    for (;;) {
        if (at >= message.length) {
            throw new Error("truncated DNS name");
        }
        const length = message[at] ?? 0;
        if (length === 0) {
            return at + 1;
        }
        // 0b11xxxxxx marks a pointer: two bytes total, and the name ends there.
        if ((length & 0xc0) === 0xc0) {
            return at + 2;
        }
        at += length + 1;
    }
};

// Every A/AAAA address in the answer section, in the server's own order (the order it wants them tried). CNAME and
// anything else is stepped over.
export const decodeAnswers = (message: Buffer): string[] => {
    if (message.length < 12) {
        throw new Error("short DNS response");
    }
    const rcode = (message.readUInt16BE(2) & 0x0f) >>> 0;
    if (rcode !== 0) {
        // 3 is NXDOMAIN: the host doesn't exist, not a broken exit; reporting it as a proxy fault misleads the caller.
        throw new Error(rcode === 3 ? "no such host" : `DNS server answered with error ${rcode}`);
    }
    const questions = message.readUInt16BE(4);
    const answers = message.readUInt16BE(6);
    let at = 12;
    for (let index = 0; index < questions; index += 1) {
        at = skipName(message, at) + 4;
    }
    const found: string[] = [];
    for (let index = 0; index < answers; index += 1) {
        at = skipName(message, at);
        if (at + 10 > message.length) {
            break;
        }
        const type = message.readUInt16BE(at);
        const length = message.readUInt16BE(at + 8);
        const data = at + 10;
        if (data + length > message.length) {
            break;
        }
        if (type === TYPE_A && length === 4) {
            found.push([...message.subarray(data, data + 4)].join("."));
        } else if (type === TYPE_AAAA && length === 16) {
            const groups: string[] = [];
            for (let byte = 0; byte < 16; byte += 2) {
                groups.push(message.readUInt16BE(data + byte).toString(16));
            }
            found.push(groups.join(":"));
        }
        at = data + length;
    }
    return found;
};

// One query, one TCP connection, bound to the exit's source address. The 2-byte length prefix is TCP DNS framing; a
// response can span several segments, so the reader waits for the full declared length.
const askOnce = (server: string, localAddress: string | undefined, host: string, type: number): Promise<string[]> =>
    new Promise((resolve, reject) => {
        const query = encodeQuery(Math.floor(Math.random() * 0xffff), host, type);
        const framed = Buffer.alloc(2 + query.length);
        framed.writeUInt16BE(query.length, 0);
        query.copy(framed, 2);
        const socket: Socket = connect({
            host: server,
            port: DNS_PORT,
            ...(localAddress === undefined ? {} : { localAddress }),
        });
        let buffer = Buffer.alloc(0);
        const finish = (error: Error | undefined, addresses?: string[]): void => {
            socket.destroy();
            if (error === undefined) {
                resolve(addresses ?? []);
            } else {
                reject(error);
            }
        };
        socket.setTimeout(QUERY_TIMEOUT_MS, () => finish(new Error(`DNS query for ${host} timed out through the exit`)));
        socket.on("error", (error) => finish(error));
        socket.on("connect", () => socket.write(framed));
        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 2) {
                return;
            }
            const expected = buffer.readUInt16BE(0);
            if (buffer.length < expected + 2) {
                return;
            }
            try {
                finish(undefined, decodeAnswers(buffer.subarray(2, expected + 2)));
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.on("close", () => finish(new Error(`DNS server ${server} closed the connection before answering for ${host}`)));
    });

export interface ExitResolver {
    // Resolvers to try in order; public ones by default, not an exit's pushed resolver (the operator's own view).
    readonly servers: readonly string[];
    // The tunnel address queries leave from; undefined when a provider has no interface (tor resolves at its exit).
    readonly localAddress?: string | undefined;
}

// Resolves a hostname through the exit: A first (what most destinations want, and the simpler SOCKS reply), AAAA only
// if no A record. Every server is tried before the lookup counts as failed.
export const resolveThroughExit = async (resolver: ExitResolver, host: string): Promise<string> => {
    let last: Error | undefined;
    for (const server of resolver.servers) {
        for (const type of [TYPE_A, TYPE_AAAA]) {
            try {
                const addresses = await askOnce(server, resolver.localAddress, host, type);
                const first = addresses[0];
                if (first !== undefined) {
                    return first;
                }
            } catch (error) {
                last = error instanceof Error ? error : new Error(String(error));
                // "no such host" is the destination's answer, not the resolver's fault; more resolvers won't make a
                // name exist.
                if (last.message === "no such host") {
                    throw last;
                }
            }
        }
    }
    throw last ?? new Error(`could not resolve ${host} through the exit`);
};
