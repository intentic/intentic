import { connect, type Socket } from "node:net";

/* DNS over TCP, hand-rolled, for one reason: the query has to leave from the EXIT's address.
 *
 * Node's resolver cannot be told which source address to send from, and a lookup that goes out over the plain
 * uplink while the connection that follows goes out through Germany is a leak with teeth. It is not the IP
 * that leaks, the page still loads from the German address, it is that geo-aware CDNs and search engines route
 * on the RESOLVER's location, so the address says Berlin and the answers say wherever this sandbox is hosted.
 * That is the exact failure the feature is supposed to prevent, arriving silently.
 *
 * TCP rather than UDP because a TCP socket takes `localAddress` and a UDP one would need a bound port plus its
 * own retry logic, and every recursive resolver worth using serves DNS on TCP/53. One query, one connection,
 * no cache: a browser behind the proxy does its own caching, and a stale entry surviving a country switch is
 * worse than a few extra round trips.
 *
 * A/AAAA only, CNAMEs followed by reading the address records the server already put in the same answer, which
 * is what every recursive resolver returns. No zone walking, no EDNS, no DNSSEC: this resolves a hostname for
 * a proxied connection, it is not a resolver library.
 */

const DNS_PORT = 53;
const QUERY_TIMEOUT_MS = 5_000;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;

// A hostname as DNS wants it: each label length-prefixed, terminated by a zero length. Labels over 63 bytes
// are illegal in DNS and rejected here rather than silently truncated into a different name.
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
    // RD (recursion desired). Nothing else: no truncation games, no authoritative answer request.
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const question = Buffer.concat([encodeName(host), Buffer.alloc(4)]);
    question.writeUInt16BE(type, question.length - 4);
    question.writeUInt16BE(CLASS_IN, question.length - 2);
    return Buffer.concat([header, question]);
};

// Step over a name at `offset`, honouring compression pointers, and return where the record continues. Only
// the LENGTH matters here (the names in answers are never needed), so this skips rather than decodes.
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
        // 0b11xxxxxx is a pointer: two bytes total and the name ends there.
        if ((length & 0xc0) === 0xc0) {
            return at + 2;
        }
        at += length + 1;
    }
};

// Every A/AAAA address in the answer section, in the order the server gave them (which is the order it wants
// them tried). CNAME and everything else is stepped over: the addresses that matter are already in here.
export const decodeAnswers = (message: Buffer): string[] => {
    if (message.length < 12) {
        throw new Error("short DNS response");
    }
    const rcode = (message.readUInt16BE(2) & 0x0f) >>> 0;
    if (rcode !== 0) {
        // 3 is NXDOMAIN, the only one worth naming: it means the host does not exist, not that the exit is
        // broken, and a caller reporting it as a proxy fault would send someone hunting the wrong thing.
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

// One query, one TCP connection, source-bound. The 2-byte length prefix is TCP DNS's framing; a response can
// arrive across several segments, so the reader waits for the full declared length before parsing.
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
    // Resolvers to try in order. Public ones by default: an exit's own pushed resolver often belongs to the
    // relay operator, which is exactly whose view of the world we are least interested in adopting.
    readonly servers: readonly string[];
    // The tunnel address queries leave from. Undefined for a provider that has no interface of its own (tor
    // resolves at its exit and never comes through here).
    readonly localAddress?: string | undefined;
}

// Resolve a hostname through the exit. A4 first because it is what almost every destination wants and the
// SOCKS reply is simpler for it; AAAA only when there is no A record at all. Every server is tried before the
// lookup is called a failure, so one unreachable resolver is not an outage.
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
                // "no such host" is the destination's answer, not this resolver's failure: trying three more
                // resolvers cannot make a name exist, and the wait is the caller's to pay.
                if (last.message === "no such host") {
                    throw last;
                }
            }
        }
    }
    throw last ?? new Error(`could not resolve ${host} through the exit`);
};
