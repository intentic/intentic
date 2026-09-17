import { describe, expect, it } from "vitest";
import { bearerOf, signJwt, verifyJwt } from "./jwt.js";

const secret = `s3cret-${Math.random()}`;

describe(`HS256 tokens`, () => {
    it(`round-trips a payload under the same secret`, () => {
        const payload = { document: { key: `k1`, url: `http://x/doc/k1` }, status: 2 };
        expect(verifyJwt(signJwt(payload, secret), secret)).toEqual(payload);
    });

    it(`refuses another secret, a tampered body and a malformed token`, () => {
        const token = signJwt({ status: 2 }, secret);
        expect(verifyJwt(token, `${secret}x`)).toBeUndefined();
        const [header, , signature] = token.split(`.`) as [string, string, string];
        const forged = `${header}.${Buffer.from(JSON.stringify({ status: 6 })).toString(`base64url`)}.${signature}`;
        expect(verifyJwt(forged, secret)).toBeUndefined();
        expect(verifyJwt(`not.a.jwt.at.all`, secret)).toBeUndefined();
        expect(verifyJwt(``, secret)).toBeUndefined();
    });

    it(`refuses a token declaring another algorithm, even with a matching signature`, () => {
        const token = signJwt({ status: 2 }, secret);
        const [, body, signature] = token.split(`.`) as [string, string, string];
        const none = Buffer.from(JSON.stringify({ alg: `none`, typ: `JWT` })).toString(`base64url`);
        expect(verifyJwt(`${none}.${body}.${signature}`, secret)).toBeUndefined();
    });

    it(`reads a bearer header and nothing else`, () => {
        expect(bearerOf(`Bearer abc.def.ghi`)).toBe(`abc.def.ghi`);
        expect(bearerOf(`bearer abc`)).toBe(`abc`);
        expect(bearerOf(`Basic abc`)).toBeUndefined();
        expect(bearerOf(undefined)).toBeUndefined();
    });
});
