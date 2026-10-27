import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { computed, ref } from "vue";
import type { AccessReason } from "../../client/sandbox/access/accessReason";

// Who may answer a need, and who it waits on for anyone else: a maintainer's answer, except a release, which its
// approvers answer whatever their tier.

const known = ref(true);
const refused = ref<AccessReason | undefined>(undefined);
const email = ref<string | undefined>(`viewer@acme.dev`);
jest.mock("../../client/sandbox/access/useAccess", () => ({
    useAccess: () => ({
        known,
        role: computed(() => undefined),
        refusal: () => refused.value,
        can: () => known.value && refused.value === undefined,
    }),
}));
jest.mock("../../client/session/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail: email }) }));

const { useNeedReach } = await import("./needReach");

const need = (subject: Need[`subject`]): Need => ({
    id: `need-1`,
    conversationId: `cnv-1`,
    subject,
    title: `A need`,
    status: `open`,
    createdAt: 0,
    updatedAt: 0,
});
const SECRET = need({ kind: `secret`, name: `STRIPE_SECRET_KEY` });
const RELEASE = need({ kind: `release`, subject: `github`, approvers: [`Viewer@acme.dev`] });

afterEach(() => {
    known.value = true;
    refused.value = undefined;
    email.value = `viewer@acme.dev`;
});

describe(`useNeedReach`, () => {
    it(`lets a maintainer answer, and anyone below read it as waiting on a maintainer`, () => {
        const reach = useNeedReach();
        expect(reach.mayAnswer(SECRET)).toBe(true);

        refused.value = { kind: `tier`, floor: `maintainer` };
        expect(reach.mayAnswer(SECRET)).toBe(false);
        expect(reach.waiter.value).toBe(`maintainer`);
    });

    it(`refuses nothing while the reader's access is not known yet`, () => {
        known.value = false;
        expect(useNeedReach().mayAnswer(SECRET)).toBe(true);
    });

    it(`leaves a release to the approvers its gate names, whatever their tier`, () => {
        refused.value = { kind: `tier`, floor: `maintainer` };
        const reach = useNeedReach();
        expect(reach.mayAnswer(RELEASE)).toBe(true);

        email.value = `someone@acme.dev`;
        expect(reach.mayAnswer(RELEASE)).toBe(false);
    });
});
