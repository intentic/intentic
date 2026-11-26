import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { oneLine } from "@intentic/base/one-line";
import type { ExtensionServerApi, JobEnd, JobSpec, StartedJob, ToolArguments, ToolCallContext, ToolResult } from "@intentic/extension-api";

/* THE KIT IN THE PERSON'S OWN BROWSER (2026-11-26, moved from the daemon's peer door). The browser extension they
   installed runs the kit itself (_devices/webext, kits/chatgpt), so a call here is that browser's own tool, reached
   through `api.ownerBrowser.call`, the door the agent's own calls take, where the browser's site switches and asks apply
   and the daemon adds the tickets its `files` are collected with.
   chatgpt_image does not hold the turn (2026-11-17, the shinobi-society audit: four calls there averaged 345 s, three of
   them failing, and an agent making a set sat idle most of an hour). It is filed as a background job in the calling
   conversation (`api.jobs.start`) and the agent is answered within seconds with its id: `wait` collects the saved path
   or the failure, and a turn ended on it is woken by its end. Calls queue per browser in a lane of this extension's own:
   two at once, each in its own tab, one chat's calls one after another. One answered within QUICK_MS (the site not
   allowed, the browser asleep or paused) is handed back as the call's own answer, so a refusal still reads as one. A
   turn with no conversation has nobody to wake, so its call waits in the call. */

type OwnerApi = Pick<ExtensionServerApi, "ownerBrowser" | "jobs" | "log">;

// How many images one browser makes at once: each is a tab of its own, and ChatGPT's own limit on images in flight is
// not published, so two, with the rest queued, rather than a refusal from ChatGPT mid-set.
export const IMAGES_AT_ONCE = 2;

// How long the call waits for the browser before it answers with the job: a refusal comes back sooner than this.
const QUICK_MS = 5_000;

const IMAGE_TOOL = "chatgpt_image";

/** One call of the browser's own ChatGPT tool, answered as it answered. */
export const inOwnerBrowser = async (api: OwnerApi, context: ToolCallContext, browser: string, tool: string, args: ToolArguments): Promise<ToolResult> =>
    await api.ownerBrowser.call(context, { browser, tool, args });

/** What the browser's answer comes to as a job's end: its words, and whether it failed. */
export const jobEndOf = (result: ToolResult): JobEnd => {
    const words = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    return { ok: result.isError !== true, output: words === "" ? "The browser answered with no words." : words };
};

// The chat a call continues, as one key whether it was given as an id or as its chatgpt.com address.
const chatKey = (chat: string | undefined): string | undefined => (chat === undefined ? undefined : (/\/c\/([\w-]+)/u.exec(chat)?.[1] ?? chat.trim()));

const clock = (): string => `${new Date().toISOString().slice(11, 19)} UTC`;
const images = (count: number): string => `${count} image${count === 1 ? "" : "s"}`;

// The job's output until it ends.
const startedWords = (browser: string, prompt: string): string =>
    [
        `ChatGPT image in browser "${browser}": "${oneLine(prompt, 200)}"`,
        `Waiting for its turn in this browser (${IMAGES_AT_ONCE} at once), then sent to it.`,
        `If this job ends "lost" (the sandbox restarted meanwhile) or saying the extension let go of it, the prompt may already have gone: do not send it again. The image may still be on the artifacts shelf, or on its ChatGPT tab in that browser (\`tabs\` lists it).`,
    ].join("\n");

const startedAnswer = (id: string, ahead: number): ToolResult => ({
    content: [
        {
            type: "text",
            text: [
                `Started: job "${id}". ChatGPT is making this image in the person's browser${ahead === 0 ? "" : `, once the ${images(ahead)} ahead of it there are done`}, and nothing here waits on it.`,
                `Collect it with the \`wait\` tool on the \`subagents\` server (mcp__subagents__wait in most tool lists), target "${id}": it answers once the image is saved, with its path and the chat id, or with why no image was made. For several jobs, name them all in \`targets\`: it answers once every one has ended, or early for one that failed.`,
                "Meanwhile, start the other images you need or do other work; or end your turn, and the job's end wakes this conversation.",
                `Do not call ${IMAGE_TOOL} with this prompt again: it is already on its way, and a second call sends it twice.`,
            ].join("\n"),
        },
    ],
});

const NOT_YET = Symbol("not yet");

export interface ImageCall {
    readonly prompt: string;
    readonly chat?: string | undefined;
    readonly args: ToolArguments;
}

/** chatgpt_image in the person's browser: queued in its lane and filed as a job, or answered at once when it is quick. */
export const ownerImage = async (api: OwnerApi, context: ToolCallContext, browser: string, image: ImageCall, quickMs = QUICK_MS): Promise<ToolResult> => {
    if (context.conversationId === undefined) {
        return await inOwnerBrowser(api, context, browser, IMAGE_TOOL, image.args);
    }
    const ended = Promise.withResolvers<JobEnd>();
    const started = await fileJob(api, context, browser, image, ended);
    if (started === undefined) {
        return await inOwnerBrowser(api, context, browser, IMAGE_TOOL, image.args);
    }
    const quick = await within(ended.promise, quickMs, NOT_YET);
    if (quick === NOT_YET) {
        return startedAnswer(started.id, started.ahead);
    }
    return quick.ok ? { content: [{ type: "text", text: quick.output }] } : { content: [{ type: "text", text: quick.output }], isError: true };
};

// The job's work: its turn in the lane come, the browser's own chatgpt_image called, its end told to `ended` too.
const imageWork =
    (api: OwnerApi, browser: string, image: ImageCall, ended: PromiseWithResolvers<JobEnd>): JobSpec["run"] =>
    async (job) => {
        job.say(`Its turn came at ${clock()}: sent to the browser.`);
        let end: JobEnd;
        try {
            end = jobEndOf(await api.ownerBrowser.call(job, { browser, tool: IMAGE_TOOL, args: image.args }));
        } catch (error) {
            end = { ok: false, output: job.signal.aborted ? "Stopped: the browser was told to give up on it." : `The call to the browser failed: ${errorMessage(error)}` };
        }
        ended.resolve(end);
        return end;
    };

// The image filed as a job whose work tells `ended` its end; undefined when the sandbox would not file it (its
// conversation unknown, no room for the job's files), and the call then does the work itself.
const fileJob = async (
    api: OwnerApi,
    context: ToolCallContext,
    browser: string,
    image: ImageCall,
    ended: PromiseWithResolvers<JobEnd>,
): Promise<StartedJob | undefined> => {
    try {
        return await api.jobs.start(context, {
            command: `${IMAGE_TOOL} ${JSON.stringify(oneLine(image.prompt, 100))}`,
            description: `ChatGPT image: ${oneLine(image.prompt, 80)}`,
            started: startedWords(browser, image.prompt),
            lane: { name: `images:${browser}`, key: chatKey(image.chat), most: IMAGES_AT_ONCE },
            run: imageWork(api, browser, image, ended),
        });
    } catch (error) {
        api.log(`chatgpt: an image in browser "${browser}" could not be filed as a job, so its call does the work: ${errorMessage(error)}`);
        return undefined;
    }
};
