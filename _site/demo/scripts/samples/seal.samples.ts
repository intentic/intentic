import type { GroupSamples } from "./context.ts";

// The house is read and set; a conversation is made private and shared again, asked for, answered and opened. In the
// smoke's mode (no full fleet) nothing is sealed, so the asks and the opening answer the daemon's refusal, which is a
// served answer too.
export const sealSamples: GroupSamples<`seal`> = ({ fleet }) => ({
    house: undefined,
    setHouse: { mode: `chooses` },
    setDefault: { private: false },
    set: { id: fleet.REVIEW_AGENT_ID, private: false },
    ask: { id: fleet.REVIEW_AGENT_ID },
    answer: { id: fleet.REVIEW_AGENT_ID, email: `max@acme.dev`, answer: `decline` },
    open: { id: fleet.REVIEW_AGENT_ID, reason: `The smoke checks the door opens and closes.` },
    approveOpen: { id: fleet.REVIEW_AGENT_ID, open: `open-none`, agree: false },
});
