import { useAgents } from "../useAgents";
import { asksFirst, cleared } from "./foreignPress";

// A conversation's auto-land answer set by hand, from a surface that writes it straight to the card (the composer's
// landing row, the send-later list). Turning it ON for somebody else's conversation is a land agreed to in advance, so
// it asks first like the land itself (foreignPress); turning it off only makes their work wait, and asks nothing.

/**
 * Writes the answer (null: follow the sandbox's). `lands` is what the conversation will do once it is written, which the
 * caller knows and the answer alone doesn't say: null lands where the sandbox does.
 */
export const pressAutoLand = async (id: string, answer: boolean | null, lands: boolean): Promise<void> => {
    if (lands && asksFirst(id, undefined) && !(await cleared(`autoLand`, id, undefined))) {
        return;
    }
    await useAgents().setAutoLand(id, answer);
};
