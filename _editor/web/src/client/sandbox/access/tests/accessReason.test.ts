import { SandboxHttpError, wordsOf } from "../../sandboxHttpError";
import { accessReasonOf, foreseenRefusal, reasonOfRefusal } from "../accessReason";

// Every way the daemon says "not for you", read into the one reason a view draws from; and every other failure left a
// failure, since an access answer drawn for a fault would hide the fault.

const refusal = (status: number, body: unknown): SandboxHttpError => new SandboxHttpError(status, `refused`, wordsOf(body));

describe(`accessReasonOf`, () => {
    it(`reads the role floor's refusal as the tier it wanted`, () => {
        expect(accessReasonOf(refusal(403, { error: `maintainer access required`, floor: `maintainer`, reason: `floor` }))).toEqual({
            kind: `tier`,
            floor: `maintainer`,
        });
    });

    it(`tells a guest off its list and a person whose agents are off from a tier`, () => {
        expect(accessReasonOf(refusal(403, { error: `not open to a guest member`, floor: `viewer`, reason: `guest` }))).toEqual({ kind: `guest` });
        expect(accessReasonOf(refusal(403, { error: `running agents is not on for you here`, floor: `collaborator`, reason: `agents-off` }))).toEqual({
            kind: `agents-off`,
        });
    });

    it(`reads an in-route gate's tier and an area fence from an oRPC handler's data`, () => {
        expect(accessReasonOf(refusal(403, { message: `not a sandbox maintainer`, data: { floor: `maintainer` } }))).toEqual({ kind: `tier`, floor: `maintainer` });
        expect(accessReasonOf(refusal(403, { message: `not the sandbox owner`, data: { floor: `owner` } }))).toEqual({ kind: `tier`, floor: `owner` });
        expect(accessReasonOf(refusal(403, { message: `outside your access to this workspace, which holds docs`, data: { reason: `area`, areas: [`docs`] } }))).toEqual({
            kind: `area`,
        });
    });

    it(`reads an organisation's lock with the organisation and section it names`, () => {
        expect(accessReasonOf(refusal(403, { error: `Acme manages this part of the sandbox (models)`, reason: `org-locked`, org: `Acme`, section: `models` }))).toEqual({
            kind: `org`,
            org: `Acme`,
            section: `models`,
        });
    });

    it(`leaves a 403 that names no reason, any other status, and a non-refusal as failures`, () => {
        expect(accessReasonOf(refusal(403, { error: `not authorized for this sandbox` }))).toBeUndefined();
        expect(accessReasonOf(refusal(403, { error: `x`, floor: `nobody` }))).toBeUndefined();
        expect(accessReasonOf(refusal(409, { error: `busy`, floor: `maintainer` }))).toBeUndefined();
        expect(accessReasonOf(new TypeError(`Failed to fetch`))).toBeUndefined();
        expect(accessReasonOf(null)).toBeUndefined();
    });
});

describe(`foreseenRefusal`, () => {
    it(`is true only for the refusal the editor answered itself`, () => {
        expect(foreseenRefusal(refusal(403, { error: `maintainer access required`, floor: `maintainer`, reason: `floor`, predicted: true }))).toBe(true);
        expect(foreseenRefusal(refusal(403, { error: `maintainer access required`, floor: `maintainer`, reason: `floor` }))).toBe(false);
    });
});

describe(`reasonOfRefusal`, () => {
    it(`turns the shared check's answer into the same reasons`, () => {
        expect(reasonOfRefusal({ error: `writer access required`, floor: `writer`, reason: `floor` })).toEqual({ kind: `tier`, floor: `writer` });
        expect(reasonOfRefusal({ error: `not open to a guest member`, floor: `viewer`, reason: `guest` })).toEqual({ kind: `guest` });
        expect(reasonOfRefusal({ error: `running agents is not on for you here`, floor: `collaborator`, reason: `agents-off` })).toEqual({ kind: `agents-off` });
    });
});
