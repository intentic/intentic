import type { AuditRecord } from "@intentic/sandbox-contract";
import { canonicalJson, checkChain, GENESIS_HASH, recordHash, sealRecord } from "./audit-chain.js";

const chain = (count: number, start = GENESIS_HASH): AuditRecord[] => {
    const records: AuditRecord[] = [];
    let previous = start;
    for (let index = 0; index < count; index += 1) {
        const record = sealRecord({
            v: 1,
            id: `r${index}`,
            at: 1000 + index,
            actor: { kind: "member", email: "a@example.com", role: "owner" },
            action: "settings.change",
            details: { changed: [{ key: "chatPages", from: true, to: false }] },
            prevHash: previous,
        });
        records.push(record);
        previous = record.hash;
    }
    return records;
};

const text = (records: readonly AuditRecord[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join("");

test("canonical JSON sorts keys at every depth, so field order never changes a hash", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}');
    expect(recordHash({ a: 1, b: 2 })).toBe(recordHash({ b: 2, a: 1 }));
});

test("an untouched chain checks out across segments and ends at its last hash", () => {
    const records = chain(5);
    const result = checkChain(
        [
            { name: "2026-09.jsonl", text: text(records.slice(0, 2)) },
            { name: "2026-10.jsonl", text: text(records.slice(2)) },
        ],
        GENESIS_HASH,
    );
    expect(result).toEqual({ checked: 5, broken: undefined, torn: false, lastHash: records[4]?.hash ?? "missing", lastAt: 1004 });
});

test("a record edited after it was written fails its own hash, and is named", () => {
    const records = chain(3);
    const lines = text(records).split("\n");
    lines[1] = lines[1]?.replace('"to":false', '"to":true') ?? "";
    const result = checkChain([{ name: "2026-10.jsonl", text: lines.join("\n") }], GENESIS_HASH);
    expect(result.broken).toEqual({ segment: "2026-10.jsonl", line: 2, id: "r1", at: 1001, reason: "hash-mismatch" });
    expect(result.checked).toBe(1);
});

test("a record removed from the middle breaks the link of the one after it", () => {
    const records = chain(4);
    const result = checkChain([{ name: "2026-10.jsonl", text: text([records[0], records[2], records[3]].flatMap((record) => record ?? [])) }], GENESIS_HASH);
    expect(result.broken).toEqual({ segment: "2026-10.jsonl", line: 2, id: "r2", at: 1002, reason: "chain-break" });
});

test("a line that is not a record is unreadable, not skipped", () => {
    const records = chain(2);
    const result = checkChain([{ name: "2026-10.jsonl", text: `${JSON.stringify(records[0])}\nnot json\n${JSON.stringify(records[1])}\n` }], GENESIS_HASH);
    expect(result.broken).toEqual({ segment: "2026-10.jsonl", line: 2, reason: "unreadable", id: undefined, at: undefined });
});

test("a torn last line in the newest segment is reported as torn, not as tampering", () => {
    const records = chain(2);
    const result = checkChain([{ name: "2026-10.jsonl", text: `${text(records)}{"v":1,"id":"half` }], GENESIS_HASH);
    expect(result).toMatchObject({ checked: 2, broken: undefined, torn: true });
});

test("after pruning, the chain starts from the checkpoint's hash, and the genesis no longer fits", () => {
    const records = chain(4);
    const kept = [{ name: "2026-10.jsonl", text: text(records.slice(2)) }];
    expect(checkChain(kept, records[1]?.hash ?? "").broken).toBeUndefined();
    expect(checkChain(kept, GENESIS_HASH).broken?.reason).toBe("chain-break");
});
