import { randomBytes } from "node:crypto";
import { SEAL_OPEN_HOURS, type Seal, type SealOpen } from "@intentic/sandbox-contract/schemas/seal";
import type { Caller } from "../../auth/auth.js";
import { opt } from "../../opt.js";

/* OPENING A PRIVATE CONVERSATION WITHOUT ASKING (schemas/seal.ts). The sandbox owner alone, signed in as a person (no
 * agent, panel or control token reaches the route), with a written reason the author reads. Read-only for a day, from
 * when it opens (a second person's yes, where an organisation asks for one). */

const OPEN_MS = SEAL_OPEN_HOURS * 60 * 60_000;

/** The opening the owner's press makes: pending when a second person must agree. */
export const newOpen = (caller: Caller, reason: string, twoPerson: boolean, at: number): SealOpen => {
    const open: SealOpen = { id: randomBytes(9).toString("hex"), email: caller.email.toLowerCase(), ...opt("name", caller.name), at, until: at + OPEN_MS, reason };
    if (twoPerson) {
        open.pending = true;
    }
    return open;
};

/** The opening agreed to (or refused) by a second person: its day starts with the yes. */
export const answeredOpen = (open: SealOpen, by: Caller, agree: boolean, at: number): SealOpen => {
    const { pending: _pending, ...rest } = open;
    const person = { email: by.email.toLowerCase(), ...opt("name", by.name), at };
    return agree ? { ...rest, approvedBy: person, until: at + OPEN_MS } : { ...rest, refusedBy: person };
};

/** The seal with one opening added or replaced, by id. */
export const withOpen = (seal: Seal, open: SealOpen): Seal => ({
    ...seal,
    opens: [...(seal.opens ?? []).filter((held) => held.id !== open.id), open],
});
