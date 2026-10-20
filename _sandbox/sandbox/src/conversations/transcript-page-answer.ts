import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { turnRunOf } from "./actor/conversation-holdings.js";
import type { PersistedAgent } from "./registry/agents-store.js";

// One page of a conversation's record as `agents.transcript` answers it: newest turns first, walking back on each
// `before`, not the whole conversation every time. With `after` (and no `before`), only what the record gained past the
// reader's cursor, when it still runs through it; otherwise the latest page, said not to be continuous, which the reader
// takes in place of its own.
export const transcriptPageAnswer = async (
    services: Pick<Services, "transcripts" | "conversations">,
    agent: PersistedAgent,
    input: { readonly id: string; readonly before?: number | undefined; readonly turns?: number | undefined; readonly after?: number | undefined; readonly afterRow?: string | undefined },
) => {
    const forward = input.after !== undefined && input.before === undefined;
    const page = await services.transcripts.page(agent, {
        ...opt("before", input.before),
        ...opt("turns", input.turns),
        ...opt("after", forward ? input.after : undefined),
        ...opt("afterRow", forward ? input.afterRow : undefined),
    });
    const answer = { messages: page.rows, from: page.from, more: page.more, through: page.through ?? page.from + page.rows.length };
    // The run the record does not hold yet, so a reader knows to attach for the rest: one still going, or one finished
    // whose record write has not landed, whose stream ends once it has.
    const run = turnRunOf(services.conversations, input.id);
    const live = run !== undefined && (!run.done || run.onRecord === false) ? run.id : undefined;
    return { ...answer, ...opt("continuous", forward ? page.continuous === true : undefined), ...opt("live", live) };
};
