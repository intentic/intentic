import { clearingSentDraft } from "./drafts";
import { homeSandboxOf } from "../../fixture/home/sandboxAt";
import { demoRefusals } from "../account/accounts";
import { queueDoors, sayOrBook, switchAccount } from "./queue";
import { routeChat } from "./chatRoute";
import { rewindRecord } from "./transcriptEdits";
import { attach, chooseHandoff, reply, resumeTurn, stopTurn } from "./turns";
import type { Doors } from "../doors";

const DEMO_COMMANDS = [
    { name: `plan`, description: `Think a change through before touching anything` },
    { name: `review`, description: `Review the working diff` },
    { name: `test`, description: `Run the affected tests`, hint: `[path]` },
];

export const agentDoors = {
    run: (input, call) => clearingSentDraft(sayOrBook)(input, homeSandboxOf(call.url)),
    ...queueDoors,
    switchAccount,
    attach: ({ conversationId }, call) => attach(conversationId, homeSandboxOf(call.url)),
    reply,
    steer: () => ({ delivered: `steered` as const }),
    stop: (input, call) => stopTurn(input, homeSandboxOf(call.url)),
    resume: (input, call) => resumeTurn(input, homeSandboxOf(call.url)),
    chooseHandoff,
    rewind: (input, call) => rewindRecord(input, homeSandboxOf(call.url)),
    routeChat,
    commands: () => ({ commands: DEMO_COMMANDS }),
    refusals: demoRefusals,
} satisfies Doors<`agent`>;
