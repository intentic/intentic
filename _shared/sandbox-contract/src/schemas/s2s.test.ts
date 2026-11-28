import { RAW_JSON_ROUTES } from "../protocol/raw/raw-json-routes.js";
import { RAW_ROUTES } from "../protocol/raw/raw-routes.js";
import { LINK_TURNS_PER_HOUR_DEFAULT } from "./links.js";
import { NeedAskSchema, NeedSubjectSchema } from "./needs.js";
import {
    S2S_CALL_METHODS,
    S2S_CALLS,
    S2S_PAYLOAD_KINDS,
    S2S_REFUSAL_CODES,
    S2S_REFUSAL_STATUS,
    S2sAddressSchema,
    S2sContactScopeSchema,
    S2sGrantsSchema,
    S2sPayloadSchema,
    S2sTaskGrantSchema,
} from "./s2s.js";

const s2sRoutes = Object.entries(RAW_ROUTES).filter(([key]) => key.includes(` /s2s/`) || key.endsWith(`/upgrade`) || key.endsWith(`/contact-bootstrap`));

describe("grants", () => {
    it("default to messages only", () => {
        expect(S2sGrantsSchema.parse({})).toEqual({ message: true, report: false, records: false, operate: false, wake: false });
    });

    it("carry a task grant as the link terms do, under their names and defaults", () => {
        expect(S2sTaskGrantSchema.parse({})).toEqual({ approve: false, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT });
        expect(S2sTaskGrantSchema.parse({ actsAs: `reviewer`, approve: true })).toEqual({ actsAs: `reviewer`, approve: true, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT });
        expect(S2sTaskGrantSchema.safeParse({ turnsPerHour: 121 }).success).toBe(false);
    });
});

describe("addresses and scopes", () => {
    it("take a host, a domain, localhost with a port, and nothing uppercase or with a path", () => {
        for (const ok of [`0123456789ab.sandbox.example`, `ops.acme.example`, `localhost:8443`, `a.b:65535`]) {
            expect(S2sAddressSchema.safeParse(ok).success).toBe(true);
        }
        for (const bad of [`Ops.Example`, `ops.example/x`, `ops`, `https://ops.example`, `ops.example.`]) {
            expect(S2sAddressSchema.safeParse(bad).success).toBe(false);
        }
    });

    it("names the person of a person-scoped contact and nobody for a sandbox-scoped one", () => {
        expect(S2sContactScopeSchema.parse({ kind: `person`, person: `ada@acme.example` })).toEqual({ kind: `person`, person: `ada@acme.example` });
        expect(S2sContactScopeSchema.safeParse({ kind: `person` }).success).toBe(false);
    });
});

describe("payloads", () => {
    it("have one schema per kind the header may name, and refuse any other", () => {
        expect(S2S_PAYLOAD_KINDS.length).toBe(13);
        expect(S2sPayloadSchema.safeParse({ kind: `poll.vote` }).success).toBe(false);
        expect(S2sPayloadSchema.parse({ kind: `message`, text: `hi` })).toEqual({ kind: `message`, text: `hi`, attachments: [] });
        expect(S2sPayloadSchema.parse({ kind: `task.stop`, task: `r-1` })).toEqual({ kind: `task.stop`, task: `r-1` });
    });

    it("carry a report and a task in the account report's and the link task's own fields", () => {
        const report = { kind: `report`, project: `github.com/acme/app`, report: { kind: `detection`, title: `x`, fingerprint: `f`, message: `m` }, times: 2 };
        expect(S2sPayloadSchema.safeParse(report).success).toBe(true);
        // The project a pass used to carry rides the report itself.
        const { project: _project, ...unnamed } = report;
        expect(S2sPayloadSchema.safeParse(unnamed).success).toBe(false);
        expect(S2sPayloadSchema.parse({ kind: `task.request`, requestId: `r-1`, task: `do it` })).toEqual({ kind: `task.request`, requestId: `r-1`, task: `do it`, hops: 0 });
    });
});

describe("refusals", () => {
    it("answer a status for every code and never 401, which a sender reads as a daemon too old for the door", () => {
        expect(Object.keys(S2S_REFUSAL_STATUS).toSorted()).toEqual([...S2S_REFUSAL_CODES].toSorted());
        expect(Object.values(S2S_REFUSAL_STATUS).toSorted((a, b) => a - b)).toEqual([400, 403, 403, 403, 403, 403, 403, 409, 409, 409, 409, 409, 413, 422, 429, 503]);
        expect(S2S_REFUSAL_STATUS.rate).toBe(429);
        // A task refused in words (no such task, not allowed yet, the grant's hourly turns spent) is never retried.
        expect(S2S_REFUSAL_STATUS.task).toBe(409);
        expect(S2S_REFUSAL_STATUS.unready).toBe(503);
        expect(S2S_REFUSAL_STATUS.unknown_kind).toBe(422);
        // A call's session gone, or a call replayed or held back: refused in words, never 401.
        expect(S2S_REFUSAL_STATUS.session).toBe(409);
        expect(S2S_REFUSAL_STATUS.replay).toBe(409);
    });
});

describe("calls", () => {
    it("give every method a grant, an input and an answer", () => {
        expect(Object.keys(S2S_CALLS).toSorted()).toEqual([...S2S_CALL_METHODS].toSorted());
        expect(S2S_CALLS[`operate.exec`].grant).toBe(`operate`);
        expect(S2S_CALLS[`records.bundle`].grant).toBe(`records`);
        expect(S2S_CALLS[`task.watch`].grant).toBe(`task`);
    });
});

describe("the contact need", () => {
    it("is a need subject and an ask like every other kind", () => {
        const subject = { kind: `contact` as const, address: `ops.acme.example`, action: `add` as const, grants: { report: true } };
        expect(NeedSubjectSchema.parse(subject)).toEqual({ ...subject, grants: { message: true, report: true, records: false, operate: false, wake: false } });
        expect(NeedAskSchema.parse({ kind: `contact`, action: `accept`, contactId: `c-1` })).toEqual({
            kind: `contact`,
            action: `accept`,
            contactId: `c-1`,
            grants: { message: true, report: false, records: false, operate: false, wake: false },
        });
    });
});

describe("the s2s routes", () => {
    it("are doors that check their own credential for another daemon, and no control token reaches any", () => {
        const doors = s2sRoutes.filter(([, meta]) => `auth` in meta && meta.auth === `door`).map(([key]) => key);
        expect(doors.toSorted()).toEqual(
            [
                `GET /s2s/identity`,
                `POST /s2s/inbox`,
                `POST /s2s/session`,
                `POST /s2s/call/{method}`,
                `POST /link/upgrade`,
                `POST /account/pairings/upgrade`,
                `POST /account/contact-bootstrap`,
            ].toSorted(),
        );
        expect(s2sRoutes.filter(([, meta]) => !(`control` in meta) || meta.control !== `never`).map(([key]) => key)).toEqual([]);
    });

    it("keep the recovery key the owner's alone", () => {
        expect(RAW_ROUTES[`POST /s2s/me/recovery`]).toEqual({ floor: `owner`, panel: false, control: `never` });
        expect(RAW_ROUTES[`POST /s2s/me/recover`]).toEqual({ floor: `owner`, panel: false, control: `never` });
    });

    it("register paired before a contact's id, which would otherwise take it", () => {
        const keys = Object.keys(RAW_ROUTES);
        expect(keys.indexOf(`POST /s2s/contacts/paired`)).toBeLessThan(keys.indexOf(`POST /s2s/contacts/{id}`));
    });

    it("answer JSON on every one but a message's file, which answers its bytes", () => {
        expect(s2sRoutes.map(([key]) => key).filter((key) => !(key in RAW_JSON_ROUTES))).toEqual([`GET /s2s/messages/{id}/files/{name}`]);
    });
});
