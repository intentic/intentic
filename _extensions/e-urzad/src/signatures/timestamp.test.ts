import * as asn1js from "asn1js";
import { ContentInfo, TSTInfo } from "pkijs";
import { type Pki, pki, timestampToken } from "./fixtures.testing.js";
import { NO_TRUST_LIST, signedDataOf, verifyTimestamp } from "./timestamp.js";

// A token is judged by PKI.js's answers (its imprint check, its error codes), not by the words of what it throws.

let parties: Pki;

beforeAll(async () => {
    parties = await pki();
});

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

const reencoded = (signed: ReturnType<typeof signedDataOf>): Uint8Array =>
    new Uint8Array(new ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: signed.toSchema(true) }).toSchema().toBER(false));

test("a token over the stamped bytes verifies; over other bytes it is invalid", async () => {
    const token = await timestampToken(bytes("podpis"), parties.tsa);
    expect(await verifyTimestamp(token, bytes("podpis"), "signature-timestamp", NO_TRUST_LIST)).toMatchObject({ integrity: "valid" });
    expect(await verifyTimestamp(token, bytes("inny podpis"), "signature-timestamp", NO_TRUST_LIST)).toMatchObject({ integrity: "invalid", detail: "the time-stamp does not cover these bytes" });
});

test("a TSTInfo changed after the TSA signed it is invalid", async () => {
    const signed = signedDataOf(await timestampToken(bytes("podpis"), parties.tsa));
    const content = signed.encapContentInfo.eContent;
    if (content === undefined) {
        throw new Error("the fixture token carries no TSTInfo");
    }
    const info = TSTInfo.fromBER(content.getValue());
    info.serialNumber = new asn1js.Integer({ value: 8 });
    signed.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: info.toSchema().toBER(false) });
    expect(await verifyTimestamp(reencoded(signed), bytes("podpis"), "signature-timestamp", NO_TRUST_LIST)).toMatchObject({ integrity: "invalid" });
});

test("a token missing its message-digest attribute is not checked, and says why", async () => {
    const signed = signedDataOf(await timestampToken(bytes("podpis"), parties.tsa));
    const attributes = signed.signerInfos[0]?.signedAttrs?.attributes;
    if (attributes === undefined) {
        throw new Error("the fixture token carries no signed attributes");
    }
    attributes.splice(attributes.findIndex((attribute) => attribute.type === "1.2.840.113549.1.9.4"), 1);
    const facts = await verifyTimestamp(reencoded(signed), bytes("podpis"), "signature-timestamp", NO_TRUST_LIST);
    expect(facts.integrity).toBe("not-checked");
    expect(facts.detail).toContain("message-digest");
});
