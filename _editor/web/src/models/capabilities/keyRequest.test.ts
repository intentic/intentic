import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { certificateRequestInput, keyRequestScope, subjectFields, unansweredSubject } from "./keyRequest";

// A key the sandbox makes with a certificate request for it: the subject's fields are the only answers sent, and the
// request waits for the required ones.

const keyField: CapabilityField = {
    key: `privateKey`,
    label: `Key and certificate request`,
    secret: true,
    keyRequest: { subject: { C: `\${country}`, O: `\${organization}`, OU: `\${unit}`, CN: `\${commonName}` }, request: `certificateRequest` },
};

const card: CapabilityCatalogEntry = {
    id: `e-doreczenia`,
    name: `e-Doręczenia`,
    kind: `cli`,
    category: `communication`,
    description: `A mailbox.`,
    fields: [
        { key: `provider`, label: ``, value: `e-doreczenia` },
        { key: `organization`, label: `Organization (O)` },
        { key: `commonName`, label: `Domain (CN)` },
        { key: `country`, label: `Country (C)`, default: `PL` },
        { key: `unit`, label: `Department (OU)`, optional: true },
        keyField,
        { key: `certificate`, label: `Issued certificate`, secret: true, optional: true },
    ],
};

test(`fills the subject from the fields its templates name, in the card's order`, () => {
    expect(subjectFields(card, keyField).map((field) => field.key)).toEqual([`organization`, `commonName`, `country`, `unit`]);
});

test(`waits for every required subject answer, not an optional one`, () => {
    expect(unansweredSubject(card, keyField, { organization: `Urzad`, commonName: ` `, country: `PL` }).map((field) => field.key)).toEqual([`commonName`]);
    expect(unansweredSubject(card, keyField, { organization: `Urzad`, commonName: `ezd.example.pl`, country: `PL` })).toEqual([]);
});

test(`asks for the card's own key, with the subject's answers and nothing else`, () => {
    expect(
        certificateRequestInput(card, keyField, { organization: ` Urzad `, commonName: `ezd.example.pl`, country: `PL`, certificate: `secret`, systemName: `EZD` }),
    ).toEqual({
        kind: `cli`,
        provider: `e-doreczenia`,
        field: `privateKey`,
        values: { organization: `Urzad`, commonName: `ezd.example.pl`, country: `PL`, unit: `` },
    });
    expect(keyRequestScope(`e-doreczenia`)).toBe(`capabilities/e-doreczenia/key-request`);
    expect(keyRequestScope(`e-doreczenia`, `office`)).toBe(`capabilities/e-doreczenia/key-request/office`);
});
