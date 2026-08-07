import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudCredentialError } from "./common.js";
import { parseOciConfig, signedHeaders, signingString } from "./oci-sign.js";

const { privateKey, publicKey } = generateKeyPairSync(`rsa`, { modulusLength: 2048 });
const pem = privateKey.export({ type: `pkcs8`, format: `pem` }).toString();

const snippet = [
    `[DEFAULT]`,
    `user=ocid1.user.oc1..alice`,
    `fingerprint=aa:bb:cc`,
    `tenancy=ocid1.tenancy.oc1..acme`,
    `region=eu-frankfurt-1`,
    `key_file=<path to your private keyfile> # TODO`,
].join(`\n`);

describe(`parseOciConfig`, () => {
    it(`reads the console snippet, ignoring the section header, comments and key_file`, () => {
        const credential = parseOciConfig(snippet, pem);
        expect(credential).toMatchObject({
            user: `ocid1.user.oc1..alice`,
            fingerprint: `aa:bb:cc`,
            tenancy: `ocid1.tenancy.oc1..acme`,
            region: `eu-frankfurt-1`,
        });
    });

    it(`names every missing field instead of failing one at a time`, () => {
        expect(() => parseOciConfig(`user=ocid1.user.oc1..alice`, pem)).toThrowError(/tenancy, fingerprint, region/);
    });

    it(`rejects an unreadable key PEM at parse time, not as a later 401`, () => {
        expect(() => parseOciConfig(snippet, `-----BEGIN PRIVATE KEY-----\ntruncated`)).toThrowError(CloudCredentialError);
    });
});

describe(`signedHeaders`, () => {
    const credential = parseOciConfig(snippet, pem);
    const date = new Date(`2026-08-07T12:00:00Z`);

    // Recompose the signing string the way the spec dictates and check the RSA signature actually covers it —
    // the composition is the part a 401 would never diagnose.
    const verify = (headers: Record<string, string>, expectedSigningString: string) => {
        const signature = /signature="([^"]+)"/.exec(headers[`authorization`] ?? ``)?.[1] ?? ``;
        expect(createVerify(`RSA-SHA256`).update(expectedSigningString).verify(publicKey, signature, `base64`)).toBe(true);
    };

    it(`signs date, (request-target) and host on a GET`, () => {
        const url = new URL(`https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances?compartmentId=x`);
        const headers = signedHeaders(credential, `GET`, url, undefined, date);
        expect(headers[`authorization`]).toContain(`keyId="ocid1.tenancy.oc1..acme/ocid1.user.oc1..alice/aa:bb:cc"`);
        expect(headers[`authorization`]).toContain(`headers="date (request-target) host"`);
        expect(headers[`date`]).toBe(date.toUTCString());
        verify(
            headers,
            signingString([
                [`date`, date.toUTCString()],
                [`(request-target)`, `get /20160918/instances?compartmentId=x`],
                [`host`, `iaas.eu-frankfurt-1.oraclecloud.com`],
            ]),
        );
    });

    it(`adds and signs the content headers on a request with a body`, () => {
        const url = new URL(`https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/vcns`);
        const body = JSON.stringify({ cidrBlock: `10.0.0.0/16` });
        const headers = signedHeaders(credential, `POST`, url, body, date);
        expect(headers[`authorization`]).toContain(`headers="date (request-target) host content-length content-type x-content-sha256"`);
        expect(headers[`content-length`]).toBe(String(Buffer.byteLength(body)));
        expect(headers[`content-type`]).toBe(`application/json`);
        verify(
            headers,
            signingString([
                [`date`, date.toUTCString()],
                [`(request-target)`, `post /20160918/vcns`],
                [`host`, `iaas.eu-frankfurt-1.oraclecloud.com`],
                [`content-length`, headers[`content-length`] ?? ``],
                [`content-type`, `application/json`],
                [`x-content-sha256`, headers[`x-content-sha256`] ?? ``],
            ]),
        );
    });
});
