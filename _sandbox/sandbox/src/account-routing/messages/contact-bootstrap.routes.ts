import { keyedLock } from "@intentic/base/async";
import type { SandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import {
    type S2sContactBootstrapAnswer,
    S2sContactBootstrapRequestSchema,
    S2sGrantsSchema,
    type S2sRefusalCode,
    type SandboxIdentity,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { opt } from "../../opt.js";
import { confirmAtAddress, postedDocumentProblem } from "../../s2s/contacts/contact-confirm.js";
import { grantsFor } from "../../s2s/contacts/contact-view.js";
import type { ContactsCore } from "../../s2s/contacts/contacts.js";
import type { ContactRow } from "../../s2s/contacts/contacts-store.js";
import { type AdmitRoute, routeAdmissionOf } from "../admit-route.js";

// THE INTRODUCTION (docs/architecture/messages.md, "Reports"): reports between one owner's sandboxes never needed a
// pairing, since the platform's pass said both were that owner's. They still need none: the first report to a sandbox
// that holds no contact for the sender comes here first, `POST /account/contact-bootstrap` under a report pass, with the
// sender's identity document. This side confirms the document the way the handshake confirms a stranger's (fetched from
// its own address, the same key) and that it is the sandbox the pass names, then files a sandbox-scoped contact holding
// only the `report` grant (origin `report-bootstrap`), or adds `report` to an accepted one it already has; nothing else
// about an existing contact changes. It answers its own document and the grants, and every later report is a message.
// The platform is a notary for this one introduction and nothing after.

// An identity document and room around it.
const BODY_MAX = 64 * 1024;

export interface BootstrapRefusal {
    readonly refused: string;
    readonly status: 400 | 403 | 409 | 503;
    readonly code: S2sRefusalCode;
}

const refusal = (status: BootstrapRefusal["status"], code: S2sRefusalCode, refused: string): BootstrapRefusal => ({ refused, status, code });

// The asker's document as posted: it verifies, speaks s2s/1, is not this sandbox, and is the sandbox the pass names.
const documentProblem = (document: SandboxIdentity, ours: SandboxIdentity, pass: SandboxPass): BootstrapRefusal | undefined =>
    postedDocumentProblem(document, ours) ??
    (document.sandbox === pass.from ? undefined : refusal(403, "unconfirmed", `that identity is ${document.sandbox}, not ${pass.from}, the sandbox the pass names`));

// The contact the introduction files or extends; a blocked one is answered as if it were taken, and keeps nothing. The
// pass names the sandbox, so the contact records it as vouched (contacts-store.ts vouchedSandboxOf) where it holds that key.
const filed = async (core: ContactsCore, address: string, document: SandboxIdentity): Promise<ContactRow | BootstrapRefusal> => {
    const held = (await core.deps.store.list()).find((row) => row.scope.kind === "sandbox" && (row.address === address || row.document.fingerprint === document.fingerprint));
    if (held === undefined) {
        return core.deps.store.put(
            core.newRow({
                address,
                document,
                scope: { kind: "sandbox" },
                state: "accepted",
                grants: S2sGrantsSchema.parse({ message: false, report: true }),
                origin: "report-bootstrap",
                vouchedSandbox: document.sandbox,
            }),
        );
    }
    if (held.state === "blocked") {
        return { ...held, grants: { ...held.grants, report: true } };
    }
    if (held.state !== "accepted") {
        return refusal(409, "not_contact", `${address} is a contact here waiting on a person (${held.state}): reports go the old way until it is settled`);
    }
    const vouched = held.document.fingerprint === document.fingerprint ? document.sandbox : held.vouchedSandbox;
    return (
        (await core.deps.store.change(held.id, (row) =>
            row.grants.report && row.vouchedSandbox === vouched
                ? row
                : core.touch(row, { grants: grantsFor({ ...row.grants, report: true }, row.scope), ...opt("vouchedSandbox", vouched) }),
        )) ?? held
    );
};

/** The introduction for one asker: its contact here and this sandbox's half, or why not. One at a time per asker. */
const bootstrapIn = (core: ContactsCore) => {
    const serialize = keyedLock<string>();
    return async (pass: SandboxPass, document: SandboxIdentity): Promise<S2sContactBootstrapAnswer | BootstrapRefusal> =>
        serialize(pass.from, async () => {
            const ours = await core.deps.identity().document();
            const problem = documentProblem(document, ours, pass);
            if (problem !== undefined) {
                return problem;
            }
            const at = await confirmAtAddress(core.deps.resolve, document);
            if ("refused" in at) {
                return at;
            }
            const row = await filed(core, at.address, at.document);
            return "refused" in row ? row : { contact: row.id, document: ours, grants: row.grants };
        });
};

/** The door: a report pass, then the asker's document. */
export const contactBootstrapRoute = (core: ContactsCore, admit: AdmitRoute) => {
    const introduce = bootstrapIn(core);
    return async (c: Context<AppEnv>): Promise<Response> => {
        const admitted = await admit(c, "report");
        if (admitted instanceof Response) {
            return admitted;
        }
        const read = await readBoundedJson(c.req.raw, BODY_MAX);
        const parsed = read.kind === "ok" ? S2sContactBootstrapRequestSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "an introduction carries the asking sandbox's identity: {document}", code: "malformed" }, 400);
        }
        const answer = await introduce(admitted.pass, parsed.data.document);
        return "refused" in answer ? c.json({ error: answer.refused, code: answer.code }, answer.status) : c.json(answer);
    };
};

export const contactBootstrapRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /account/contact-bootstrap": contactBootstrapRoute(services.s2s.core, routeAdmissionOf(services)),
}));
