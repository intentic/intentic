import { expect, test } from "vitest";
import { decodeAnswers, encodeName, encodeQuery, skipName } from "./exit-dns.js";

// A hand-rolled DNS codec exists here for one reason (queries must leave from the exit's address, and Node's
// resolver cannot be told a source address), so it is tested as a codec: encode what the wire expects, and
// decode what a real resolver sends back, including the parts that are easy to get subtly wrong.

const header = (flags: number, answers: number): Buffer => {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt16BE(0x1234, 0);
    buffer.writeUInt16BE(flags, 2);
    buffer.writeUInt16BE(1, 4);
    buffer.writeUInt16BE(answers, 6);
    return buffer;
};

const answerRecord = (type: number, data: Buffer): Buffer => {
    // A compression pointer for the name (0xc00c → back to the question), which is what real servers send and
    // therefore the case the parser has to survive.
    const record = Buffer.alloc(12 + data.length);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(60, 6);
    record.writeUInt16BE(data.length, 10);
    data.copy(record, 12);
    return record;
};

const question = (host: string, type: number): Buffer => {
    const name = encodeName(host);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    return Buffer.concat([name, tail]);
};

test("a hostname encodes as length-prefixed labels", () => {
    expect([...encodeName("a.bc")]).toEqual([1, 0x61, 2, 0x62, 0x63, 0]);
    // A trailing dot is the same name, not a zero-length label (which is illegal and would corrupt the query).
    expect(encodeName("example.com.")).toEqual(encodeName("example.com"));
});

test("an unencodable hostname is rejected rather than silently mangled", () => {
    expect(() => encodeName("a..b")).toThrow(/resolvable hostname/);
    expect(() => encodeName(`${"x".repeat(64)}.com`)).toThrow(/resolvable hostname/);
});

test("a query asks for recursion and exactly one name", () => {
    const query = encodeQuery(0x1234, "example.com", 1);
    expect(query.readUInt16BE(0)).toBe(0x1234);
    // RD set: without it a recursive resolver answers with a referral instead of an address.
    expect(query.readUInt16BE(2)).toBe(0x0100);
    expect(query.readUInt16BE(4)).toBe(1);
    expect(query.subarray(12, 12 + encodeName("example.com").length)).toEqual(encodeName("example.com"));
});

test("A and AAAA records decode, past a compressed name", () => {
    const a = Buffer.concat([header(0x8180, 1), question("example.com", 1), answerRecord(1, Buffer.from([93, 184, 216, 34]))]);
    expect(decodeAnswers(a)).toEqual(["93.184.216.34"]);

    const v6 = Buffer.alloc(16);
    v6.writeUInt16BE(0x2606, 0);
    v6.writeUInt16BE(0x2800, 2);
    const aaaa = Buffer.concat([header(0x8180, 1), question("example.com", 28), answerRecord(28, v6)]);
    expect(decodeAnswers(aaaa)[0]?.startsWith("2606:2800:")).toBe(true);
});

test("a CNAME in front of the address is stepped over, not tripped on", () => {
    // What every resolver actually returns for a CDN-fronted host, and the shape a naive parser reads as
    // "no addresses" because the first answer is not an A record.
    const cname = answerRecord(5, encodeName("cdn.example.net"));
    const message = Buffer.concat([header(0x8180, 2), question("example.com", 1), cname, answerRecord(1, Buffer.from([1, 2, 3, 4]))]);
    expect(decodeAnswers(message)).toEqual(["1.2.3.4"]);
});

test("a server error is reported as itself, and NXDOMAIN is named", () => {
    // NXDOMAIN is a fact about the destination, not a fault in the exit. Confusing the two sends whoever is
    // debugging after the wrong thing, and makes resolveThroughExit retry three resolvers for nothing.
    expect(() => decodeAnswers(Buffer.concat([header(0x8183, 0), question("nope.example", 1)]))).toThrow("no such host");
    expect(() => decodeAnswers(Buffer.concat([header(0x8182, 0), question("x.example", 1)]))).toThrow(/error 2/);
    expect(() => decodeAnswers(Buffer.alloc(4))).toThrow(/short DNS response/);
});

test("names are skipped by their real length, pointers included", () => {
    const message = Buffer.concat([Buffer.alloc(12), encodeName("a.bc")]);
    expect(skipName(message, 12)).toBe(12 + 6);
    // A pointer is two bytes and ends the name wherever it appears.
    const pointer = Buffer.from([0xc0, 0x0c, 0xff]);
    expect(skipName(pointer, 0)).toBe(2);
    expect(() => skipName(Buffer.from([5, 1, 2]), 0)).toThrow(/truncated/);
});
