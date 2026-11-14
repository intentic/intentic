import { textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { WEBEXT_CHATGPT_SEND_TOOL } from "@intentic/sandbox-contract/webext-links";
import {
    CHATGPT_IMAGE_FIELDS,
    CHATGPT_READ_FIELDS,
    CHATGPT_SEND_FIELDS,
    CHATGPT_SITE,
    CHATGPT_TOOL_EFFECTS,
    CHATGPT_TOOL_NAMES,
    chatgptToolDescriptions,
} from "@intentic/site-kits/chatgpt";
import { array, object, string } from "zod";
import { RefusedError } from "../../policy.js";
import type { Kit } from "../kit.js";
import { CHROME_VOICE, chatgptImage, chatgptRead, chatgptSend } from "./chrome-host.js";

// The ChatGPT kit: the person's own signed-in ChatGPT, driven in one call per prompt. Everything but this browser's
// own part is in @intentic/site-kits (its page knowledge, its steps in the page, the chat engine, the sandbox's project,
// what the agent is told, and these tools' descriptions and inputs); this browser's part is chrome-host.ts.

const DESCRIPTIONS = chatgptToolDescriptions(CHROME_VOICE);

export const CHATGPT_KIT: Kit = {
    name: "ChatGPT",
    hosts: [CHATGPT_SITE.host],
    tools: [
        tool({
            name: WEBEXT_CHATGPT_SEND_TOOL,
            description: DESCRIPTIONS.send,
            effect: CHATGPT_TOOL_EFFECTS.send,
            input: object({
                ...CHATGPT_SEND_FIELDS,
                tickets: array(string()).optional().describe("Leave this out: your sandbox adds it on the way."),
            }),
            run: async ({ prompt, chat: given, mode, files, tickets, wait: waitSeconds, name: stem, personalized: own, temporary: temp }, from) => {
                if (files.length > 0 && tickets?.length !== files.length) {
                    throw new RefusedError(
                        `Nothing was sent: this browser takes a file only through its sandbox, which adds a ticket for each on the way. Call ${WEBEXT_CHATGPT_SEND_TOOL} through your sandbox's mount of this browser.`,
                    );
                }
                return textResult(await chatgptSend(from, { prompt, chat: given, mode, tickets: tickets ?? [], waitSeconds, name: stem, personalized: own, temporary: temp }));
            },
        }),
        tool({
            name: CHATGPT_TOOL_NAMES.read,
            description: DESCRIPTIONS.read,
            effect: CHATGPT_TOOL_EFFECTS.read,
            input: object(CHATGPT_READ_FIELDS),
            run: async ({ chat: given, wait: waitSeconds, name: stem }, from) => textResult(await chatgptRead(from, { chat: given, waitSeconds, name: stem })),
        }),
        tool({
            name: CHATGPT_TOOL_NAMES.image,
            description: DESCRIPTIONS.image,
            effect: CHATGPT_TOOL_EFFECTS.image,
            input: object(CHATGPT_IMAGE_FIELDS),
            run: async ({ prompt, chat: given, name: stem, personalized: own, temporary: temp }, from) =>
                textResult(await chatgptImage(from, { prompt, chat: given, name: stem, personalized: own, temporary: temp })),
        }),
    ],
};
