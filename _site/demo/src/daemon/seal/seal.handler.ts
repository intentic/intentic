import { refuse } from "@intentic/contract-serve";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { SEAL_OPEN_HOURS, type Seal, type SealOpen, sealOpenDocumentText, SealOpenDocumentSchema } from "@intentic/sandbox-contract/schemas/seal";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { demoTier } from "../../mode";
import { passkeysList } from "../account/passkeys";
import { agentAnswer, boardAgents, broadcastRoster, roster } from "../board/roster";
import type { Doors } from "../doors";
import {
    caller,
    holdsSeal,
    houseLocked,
    houseNow,
    houseTwoPerson,
    OPEN_FOR_MS,
    sealedFromCaller,
    sealOf,
    seals,
    setHouseMode,
    setOwnDefault,
} from "./sealWorld";

// PRIVATE CONVERSATIONS' ROUTES (sandbox-contract seal.contract.ts), answered as the daemon answers them for the demo's one
// person: each write changes the seal it keeps (sealWorld.ts), the board goes out again, and the conversation comes back
// framed for her. Who may do what is the daemon's rule: a reader changes a seal and answers who asks, anyone else asks,
// the owner alone opens one without asking (with a passkey, which the demo takes at its word as it does a sign-in's), and
// someone with Full access who is not the opener agrees to an opening that waits on them.

const answered = (id: string): AgentSummary => {
    broadcastRoster();
    return agentAnswer(boardAgents().find((agent) => agent.id === id));
};
const known = (id: string): void => {
    if (!roster.agents.some((agent) => agent.id === id)) {
        refuse(`No such agent.`, 404);
    }
};

// The openings of a conversation made shared again, kept for when it is private once more.
const shelvedOpens = new Map<string, SealOpen[]>();

export const sealDoors = {
    house: () => houseNow(),
    setHouse: ({ mode }) => {
        if (houseLocked()) {
            return refuse(`Your organisation fixed who reads whose conversations here.`);
        }
        setHouseMode(mode);
        return houseNow();
    },
    setDefault: ({ private: on }) => {
        setOwnDefault(on);
        return houseNow();
    },
    set: ({ id, private: on, readers }) => {
        known(id);
        const seal = sealOf(id);
        if (seal !== undefined && !holdsSeal(id)) {
            return refuse(`Only its readers can change who reads this conversation.`);
        }
        if (!on) {
            // Every opening without asking stays on the conversation for good: shared, it waits for the next seal.
            shelvedOpens.set(id, seal?.opens ?? shelvedOpens.get(id) ?? []);
            seals.delete(id);
            return answered(id);
        }
        const author = seal?.readers[0] ?? caller();
        const opens = seal?.opens ?? shelvedOpens.get(id);
        const added = (readers ?? seal?.readers.slice(1).map((reader) => reader.email) ?? []).filter((email) => email.toLowerCase() !== author.email);
        const named = (email: string) => seal?.readers.find((reader) => reader.email === email) ?? { email: email.toLowerCase() };
        const next: Seal = { ...seal, since: seal?.since ?? Date.now(), readers: [author, ...added.map(named)] };
        if (opens !== undefined && opens.length > 0) {
            next.opens = opens;
        }
        seals.set(id, next);
        return answered(id);
    },
    ask: ({ id }) => {
        known(id);
        const seal = sealOf(id);
        if (seal === undefined || !sealedFromCaller(id)) {
            return refuse(`You can already read this conversation.`, 409);
        }
        const asks = (seal.asks ?? []).filter((ask) => ask.email !== caller().email);
        seals.set(id, { ...seal, asks: [...asks, { ...caller(), at: Date.now() }] });
        return answered(id);
    },
    answer: ({ id, email, answer }) => {
        known(id);
        const seal = sealOf(id);
        const ask = seal?.asks?.find((each) => each.email === email.toLowerCase());
        if (seal === undefined || !holdsSeal(id) || ask === undefined) {
            return refuse(`Only its readers answer who asks to read it.`);
        }
        const { at: _asked, ...person } = ask;
        const next = { ...seal, asks: seal.asks?.filter((each) => each !== ask) };
        if (answer === `day`) {
            next.grants = [...(seal.grants ?? []), { ...person, until: Date.now() + OPEN_FOR_MS, by: caller().email }];
        }
        if (answer === `always`) {
            next.readers = [...seal.readers, person];
        }
        seals.set(id, next);
        return answered(id);
    },
    prepareOpen: ({ id, reason }) => {
        known(id);
        if (demoTier !== `owner` || !sealedFromCaller(id)) {
            return refuse(`Only the sandbox's owner opens a private conversation without asking.`);
        }
        const document = sealOpenDocumentText({
            v: 1,
            purpose: `intentic-conversation-open`,
            conversationId: id,
            reason,
            nonce: crypto.randomUUID(),
            expiresAt: Date.now() + 5 * 60_000,
        });
        const credentials = passkeysList().passkeys.map((passkey) => ({ id: passkey.id }));
        return { document, rpId: window.location.hostname, credentials };
    },
    open: ({ id, document, assertion }) => {
        known(id);
        const seal = sealOf(id);
        const signed = SealOpenDocumentSchema.safeParse(JSON.parse(document));
        if (demoTier !== `owner` || seal === undefined || !signed.success || signed.data.conversationId !== id) {
            return refuse(`That is not a signed opening of this conversation.`);
        }
        if (!passkeysList().passkeys.some((passkey) => passkey.id === assertion.id)) {
            return refuse(`That passkey is not one of this sandbox's.`);
        }
        const at = Date.now();
        const open = { ...caller(), id: `open-${at.toString(36)}`, at, until: at + SEAL_OPEN_HOURS * 3_600_000, reason: signed.data.reason };
        seals.set(id, { ...seal, opens: [...(seal.opens ?? []), houseTwoPerson() ? { ...open, pending: true as const } : open] });
        return answered(id);
    },
    approveOpen: ({ id, open: openId, agree }) => {
        known(id);
        const seal = sealOf(id);
        const open = seal?.opens?.find((each) => each.id === openId && each.pending === true);
        if (seal === undefined || open === undefined || !roleAtLeast(demoTier, `maintainer`) || open.email === caller().email) {
            return refuse(`Only someone with Full access who did not ask for it agrees to an opening.`);
        }
        const at = Date.now();
        const { pending: _waited, ...rest } = open;
        const settled = agree ? { ...rest, until: at + OPEN_FOR_MS, approvedBy: { ...caller(), at } } : { ...rest, refusedBy: { ...caller(), at } };
        seals.set(id, { ...seal, opens: seal.opens?.map((each) => (each === open ? settled : each)) });
        return answered(id);
    },
} satisfies Doors<`seal`>;
