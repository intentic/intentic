import { expect, test } from "vitest";
import { decodeAnswers, encodeName, encodeQuery, skipName } from "./exit-dns.js";

// Codec tests for the hand-rolled DNS encoder/decoder, needed since Node's resolver can't be told a source address.
// Encodes what the wire expects; decodes what a real resolver sends back, compression pointers and CNAMEs included.

const header = (flags: number, answers: number): Buffer => {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt16BE(0x1234, 0);
    buffer.writeUInt16BE(flags, 2);
    buffer.writeUInt16BE(1, 4);
    buffer.writeUInt16BE(answers, 6);
    return buffer;
};

const answerRecord = (type: number, data: Buffer): Buffer => {
    // 0xc00c is a compression pointer back to the question name, which real servers send.
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
    // A trailing dot names the same host; encoding it as a label would be an illegal zero-length label.
    expect(encodeName("example.com.")).toEqual(encodeName("example.com"));
});

test("an unencodable hostname is rejected rather than silently mangled", () => {
    expect(() => encodeName("a..b")).toThrow(/resolvable hostname/);
    expect(() => encodeName(`${"x".repeat(64)}.com`)).toThrow(/resolvable hostname/);
});

test("a query asks for recursion and exactly one name", () => {
    const query = encodeQuery(0x1234, "example.com", 1);
    expect(query.readUInt16BE(0)).toBe(0x1234);
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
    // Real resolvers put the CNAME before the address for a CDN-fronted host; a parser reads that as no addresses.
    const cname = answerRecord(5, encodeName("cdn.example.net"));
    const message = Buffer.concat([header(0x8180, 2), question("example.com", 1), cname, answerRecord(1, Buffer.from([1, 2, 3, 4]))]);
    expect(decodeAnswers(message)).toEqual(["1.2.3.4"]);
});

test("a server error is reported as itself, and NXDOMAIN is named", () => {
    // NXDOMAIN is a fact about the destination, not a fault in the exit.
    expect(() => decodeAnswers(Buffer.concat([header(0x8183, 0), question("nope.example", 1)]))).toThrow("no such host");
    expect(() => decodeAnswers(Buffer.concat([header(0x8182, 0), question("x.example", 1)]))).toThrow(/error 2/);
    expect(() => decodeAnswers(Buffer.alloc(4))).toThrow(/short DNS response/);
});

test("names are skipped by their real length, pointers included", () => {
    const message = Buffer.concat([Buffer.alloc(12), encodeName("a.bc")]);
    expect(skipName(message, 12)).toBe(12 + 6);
    // A pointer is two bytes total, wherever it appears.
    const pointer = Buffer.from([0xc0, 0x0c, 0xff]);
    expect(skipName(pointer, 0)).toBe(2);
    expect(() => skipName(Buffer.from([5, 1, 2]), 0)).toThrow(/truncated/);
});
