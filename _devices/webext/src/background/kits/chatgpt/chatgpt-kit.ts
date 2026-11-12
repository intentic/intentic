import { textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { boolean, object, string } from "zod";
import type { Kit } from "../kit.js";
import { chatgptImage } from "./image.js";
import { CHATGPT_SITE } from "./site.js";

// The ChatGPT kit: images made in the person's own signed-in ChatGPT, saved into the sandbox. Its page knowledge is in
// site.ts, its steps in the page in steps.ts and page-hands.ts, and the call itself in image.ts.
export const CHATGPT_KIT: Kit = {
    name: "ChatGPT",
    hosts: [CHATGPT_SITE.host],
    tools: [
        tool({
            name: "chatgpt_image",
            description:
                "Make an image with ChatGPT in the person's own signed-in browser and save it into your sandbox, in ONE call: it opens a temporary chat in your own window, turns ChatGPT's personalization off (so the owner's memory and custom instructions stay out of the picture), sends the prompt, waits for the picture (often several minutes; up to 9), and saves it on the sandbox's artifacts shelf. Answers with the saved file's path and size, the chat id, and whatever ChatGPT wrote. Needs chatgpt.com allowed in read and act: if it is not, it says so; call ask_access then. Prompts: one sentence that starts with the style works best; long, precise prompts make different styles come out alike. For a series in one look, pass `chat` from the first answer, so the next image is made in the same chat. Once a prompt has been sent, the chat's tab stays open in your window, since a temporary chat lives only there (the oldest are let go after 20 chats); a call that fails before sending closes the tab it opened. When an answer says the prompt was sent, do not call again with the same prompt: that sends it twice.",
            // It sends a message as the owner, which adds to their ChatGPT and spends their usage, and deletes nothing.
            effect: "write",
            input: object({
                prompt: string().min(1).max(4000).describe("What to draw: best as one sentence that starts with the style, e.g. \"Watercolor storyboard frame: a fox crossing a snowy bridge at dusk.\""),
                chat: string()
                    .min(1)
                    .optional()
                    .describe(
                        "The `chat` id an earlier chatgpt_image answer gave (its chatgpt.com/c/… address works too), to make this image in that same chat for a consistent look. A temporary chat lives only in the tab it was made in: once that tab has closed or gone elsewhere it cannot be continued, and the answer says to start a new one. Omit to start a new temporary chat.",
                    ),
                name: string().min(1).max(80).optional().describe("File-name stem for the saved image, e.g. keyframe-03. Default: chatgpt-<chat>."),
                personalized: boolean()
                    .default(false)
                    .describe("Let the chat use the owner's memory and custom instructions. Default false, and leave it so unless they asked: their history leaks into the picture. A `chat` that is one of the account's own chats (not one this tool made) always has them, so it is refused unless this is true."),
            }),
            run: async ({ prompt, chat, name, personalized }, from) => textResult(await chatgptImage(from, { prompt, chat, name, personalized })),
        }),
    ],
};
