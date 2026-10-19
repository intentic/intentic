import type { SandboxPassword, SandboxPasswordsKeyring } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { presenceOf, UNREAD_PRESENCE } from "./presence.js";

const keyring = (over: Partial<SandboxPasswordsKeyring> = {}): SandboxPasswordsKeyring => ({ machine: `omen`, online: true, setUp: false, ...over });
const item: SandboxPassword = {
    name: `github`,
    title: `github.com`,
    kind: `password`,
    origins: [],
    anyField: false,
    machine: `omen`,
    mode: `each-use`,
    online: false,
    updatedAt: 0,
};

describe(`presenceOf`, () => {
    test(`a new sandbox with no computer set up keeps the tile off the rail`, () => {
        expect(presenceOf(UNREAD_PRESENCE, { items: [], keyrings: [] }, 0)).toEqual({ pending: 0, shown: false });
    });

    test(`a computer that answers without a vault is not enough`, () => {
        expect(presenceOf(UNREAD_PRESENCE, { items: [], keyrings: [keyring()] }, 0).shown).toBe(false);
    });

    test(`a computer with Passwords set up brings the tile`, () => {
        expect(presenceOf(UNREAD_PRESENCE, { items: [], keyrings: [keyring({ setUp: true })] }, 0).shown).toBe(true);
    });

    test(`a password shared here brings the tile, even with its computer offline`, () => {
        expect(presenceOf(UNREAD_PRESENCE, { items: [item], keyrings: [keyring({ online: false })] }, 0).shown).toBe(true);
    });

    test(`a request waiting on an answer brings the tile and counts`, () => {
        expect(presenceOf(UNREAD_PRESENCE, { items: [], keyrings: [] }, 2)).toEqual({ pending: 2, shown: true });
    });

    test(`once shown it stays when the computer goes away`, () => {
        expect(presenceOf({ pending: 0, shown: true }, { items: [], keyrings: [] }, 0).shown).toBe(true);
    });
});
