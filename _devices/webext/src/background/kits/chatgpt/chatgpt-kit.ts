import { textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { WEBEXT_CHATGPT_SEND_TOOL } from "@intentic/sandbox-contract/webext-links";
import { array, boolean, enum as zEnum, number, object, string } from "zod";
import { RefusedError } from "../../policy.js";
import type { Kit } from "../kit.js";
import { chatgptRead, chatgptSend } from "./answers.js";
import { chatgptImage } from "./image.js";
import { CHATGPT_SITE } from "./site.js";

// The ChatGPT kit: the person's own signed-in ChatGPT, driven in one call per prompt. Its page knowledge is in site.ts,
// its steps in the page in steps.ts, project-steps.ts and page-hands.ts, the chat itself in chat.ts, the sandbox's
// project in project.ts, and what the agent is told in answers.ts and image.ts.

const WHERE =
    "New chats go into a ChatGPT project of this sandbox's own (made on first use, with project-only memory, so the owner's saved memories and other chats stay out while apps, files and every tool work, and the chat can be opened again by its address).";

const chat = string()
    .min(1)
    .optional()
    .describe("The `chat` id an earlier answer gave (its chatgpt.com address works too), to go on in that chat. Omit to start a new chat in this sandbox's project.");
const personalized = boolean()
    .default(false)
    .describe(
        "Use the owner's own memory, custom instructions and history: a regular chat outside the project. Default false; leave it so unless they asked. Needed to send into one of the account's own chats.",
    );
const temporary = boolean()
    .default(false)
    .describe("Start a temporary chat instead of one in the project: kept out of the owner's history, but apps are off and it lives only in its tab. Rarely wanted.");
const name = string().min(1).max(80).optional().describe("File-name stem for what is saved (images, a long answer), e.g. keyframe-03. Default: chatgpt-<chat>.");
const wait = number()
    .int()
    .min(0)
    .max(540)
    .optional()
    .describe("Most seconds to wait for the answer in this call (default and maximum 540). Past it the answer says ChatGPT is still working; collect it with chatgpt_read.");

export const CHATGPT_KIT: Kit = {
    name: "ChatGPT",
    hosts: [CHATGPT_SITE.host],
    tools: [
        tool({
            name: WEBEXT_CHATGPT_SEND_TOOL,
            description: `Send one prompt to ChatGPT in the person's own signed-in browser and get its answer back, in ONE call: it opens the chat in your own window, attaches files, turns on Deep research or agent mode when asked, sends, waits, and answers with ChatGPT's words (a long answer is saved as a Markdown file in your sandbox, with its start shown), any images it made (saved into your sandbox), and the chat id. ${WHERE} Connected apps work there: name the app in the prompt ("Search my Google Drive for…"). Deep research and agent mode can take 5 to 30 minutes: when the answer says ChatGPT is still working, collect it later with chatgpt_read, never by sending again. When ChatGPT asks the person to confirm something (an app reaching outside the project, an agent step), the answer says so: this tool never presses ChatGPT's confirmations, the person does. Needs chatgpt.com allowed in read and act; call ask_access if it says so. Files must be on your sandbox's artifacts shelf, and the person is asked on the page before they go. One call at a time.`,
            // It sends a message as the owner, which adds to their ChatGPT and spends their usage, and may give it files.
            effect: "destructive",
            input: object({
                prompt: string().min(1).max(32_000).describe("What to ask ChatGPT, as you would type it."),
                chat,
                mode: zEnum(["chat", "image", "deep_research", "agent"])
                    .default("chat")
                    .describe(
                        "chat: a written answer (ChatGPT may still search the web or use an app). image: done when a picture comes (chatgpt_image is the same with image prompting advice). deep_research: a long cited report. agent: ChatGPT's agent mode, which browses and acts on its own.",
                    ),
                files: array(string().min(1))
                    .max(10)
                    .default([])
                    .describe("Files from your sandbox to attach, e.g. /work/.intentic/records/artifacts/brief.pdf. Each must be on the artifacts shelf: copy it there first."),
                wait,
                name,
                personalized,
                temporary,
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
            name: "chatgpt_read",
            description:
                "Read a ChatGPT chat's latest answer: for one still being worked on when chatgpt_send returned (Deep research, agent mode, a slow image), or after the person confirmed something ChatGPT asked them. Waits up to `wait` seconds for ChatGPT to finish, then answers like chatgpt_send: its words (long ones saved as a file), images saved into your sandbox, or that it is still working. It only reads: nothing is sent. Reopens the chat by its address if its tab is gone (not a temporary chat).",
            effect: "read",
            input: object({
                chat: string().min(1).describe("The `chat` id an earlier answer gave, or the chat's chatgpt.com address."),
                wait: wait.describe("Most seconds to wait for ChatGPT to finish (default 0: read it as it stands; at most 540)."),
                name,
            }),
            run: async ({ chat: given, wait: waitSeconds, name: stem }, from) => textResult(await chatgptRead(from, { chat: given, waitSeconds, name: stem })),
        }),
        tool({
            name: "chatgpt_image",
            description: `Make an image with ChatGPT in the person's own signed-in browser and save it into your sandbox, in ONE call: it opens a chat in your own window, sends the prompt, waits for the picture (often several minutes; up to 9), and saves it on the sandbox's artifacts shelf. Answers with the saved file's path and size, the chat id, and whatever ChatGPT wrote. ${WHERE} Needs chatgpt.com allowed in read and act: if it is not, it says so; call ask_access then. Prompts: one sentence that starts with the style works best; long, precise prompts make different styles come out alike. For a series in one look, pass \`chat\` from the first answer, so the next image is made in the same chat. When an answer says the prompt was sent, do not call again with the same prompt: that sends it twice; collect a slow one with chatgpt_read.`,
            // It sends a message as the owner, which adds to their ChatGPT and spends their usage, and deletes nothing.
            effect: "write",
            input: object({
                prompt: string().min(1).max(4000).describe("What to draw: best as one sentence that starts with the style, e.g. \"Watercolor storyboard frame: a fox crossing a snowy bridge at dusk.\""),
                chat,
                name,
                personalized,
                temporary,
            }),
            run: async ({ prompt, chat: given, name: stem, personalized: own, temporary: temp }, from) =>
                textResult(await chatgptImage(from, { prompt, chat: given, name: stem, personalized: own, temporary: temp })),
        }),
    ],
};
