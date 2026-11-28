import { canonicalBytes, canonicalJson, equalBytes, fromBase64Url, toBase32, toBase64Url, utf8 } from "./canonical.js";

describe("canonical JSON", () => {
    it("sorts keys at every depth and writes no whitespace", () => {
        expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(`{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}`);
    });

    it("sorts by UTF-16 code units, so an uppercase key comes before a lowercase one and é after z", () => {
        expect(canonicalJson({ é: 1, z: 2, Z: 3, a: 4 })).toBe(`{"Z":3,"a":4,"z":2,"é":1}`);
    });

    it("spells numbers and strings as JSON.stringify does", () => {
        expect(canonicalJson([1e21, 0.1, -0, 5, "a\"b\n", "é"])).toBe(`[1e+21,0.1,0,5,"a\\"b\\n","é"]`);
    });

    it("refuses undefined, even as a member, and NaN and the infinities", () => {
        const refusal = `canonical JSON: the value is not JSON (an undefined, a NaN or an infinity in it?)`;
        expect(() => canonicalJson({ a: { b: undefined } })).toThrow(refusal);
        expect(() => canonicalJson([1, Number.NaN])).toThrow(refusal);
        expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(refusal);
        expect(() => canonicalJson(undefined)).toThrow(refusal);
    });

    it("gives the same bytes whatever order an object was built in", () => {
        expect(equalBytes(canonicalBytes({ x: 1, y: [2] }), canonicalBytes({ y: [2], x: 1 }))).toBe(true);
        expect(equalBytes(canonicalBytes({ x: 1 }), canonicalBytes({ x: 2 }))).toBe(false);
    });
});

describe("base64url", () => {
    it("round-trips every length around a block boundary without padding", () => {
        for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
            const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 250) % 256);
            const text = toBase64Url(bytes);
            expect(text.includes(`=`)).toBe(false);
            expect(fromBase64Url(text)).toEqual(bytes);
        }
    });

    it("encodes the RFC 4648 test vectors in the url alphabet", () => {
        expect(toBase64Url(utf8(`foobar`))).toBe(`Zm9vYmFy`);
        expect(toBase64Url(utf8(`fo`))).toBe(`Zm8`);
        expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe(`-_8`);
    });

    it("refuses padding, the standard alphabet, an impossible length, and stray low bits", () => {
        expect(fromBase64Url(`Zm8=`)).toBeUndefined();
        expect(fromBase64Url(`+/8`)).toBeUndefined();
        expect(fromBase64Url(`Zm9vY`)).toBeUndefined();
        // `Zm8` is "fo", its last character's two low bits zero; `Zm9` sets one, which no encoder writes.
        expect(fromBase64Url(`Zm8`)).toEqual(utf8(`fo`));
        expect(fromBase64Url(`Zm9`)).toBeUndefined();
    });
});

describe("base32", () => {
    it("encodes the RFC 4648 test vectors, lowercase and unpadded", () => {
        expect(toBase32(utf8(``))).toBe(``);
        expect(toBase32(utf8(`f`))).toBe(`my`);
        expect(toBase32(utf8(`fo`))).toBe(`mzxq`);
        expect(toBase32(utf8(`foo`))).toBe(`mzxw6`);
        expect(toBase32(utf8(`foob`))).toBe(`mzxw6yq`);
        expect(toBase32(utf8(`fooba`))).toBe(`mzxw6ytb`);
        expect(toBase32(utf8(`foobar`))).toBe(`mzxw6ytboi`);
    });

    it("spells a SHA-256 in 52 characters", () => {
        expect(toBase32(new Uint8Array(32)).length).toBe(52);
    });
});
