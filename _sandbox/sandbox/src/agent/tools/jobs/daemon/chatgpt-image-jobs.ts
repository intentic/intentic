import { whenAborted, within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { oneLine } from "@intentic/base/one-line";
import { z } from "zod";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import { conversationProfile, type PersistedAgent } from "../../../../conversations/registry/agents-store.js";
import type { RpcMessage } from "../../turn-mounts.js";
import type { MountCall, MountEndpoints } from "../../turn-mounts.routes.js";
import type { BackgroundJobSeed } from "../background-jobs.js";
import { type DaemonJobEnd, type RunningDaemonJob, startDaemonJob } from "./daemon-jobs.js";
import { createJobLanes, type JobLanes } from "./job-lanes.js";

/* CHATGPT IMAGES IN THE OWNER'S BROWSER, WITHOUT HOLDING THE TURN (2026-11-17, the shinobi-society audit). chatgpt_image
   is one call into the extension, which opens a tab, sends the prompt and watches ChatGPT until the picture is saved or
   nine minutes pass (@intentic/site-kits' chat engine). The agent's call waited all of it: four calls there averaged
   345 s, three of them failing, so an agent making a set of pictures sat idle most of an hour. At this door the call now
   goes on in the daemon as a job (daemon-jobs.ts) and the agent is answered within seconds with its id: `wait` collects
   the saved path or the failure, and a turn ended on it is woken by its end, as for a `run_in_background` command.
   Calls queue per browser (job-lanes.ts): two at once, each in its own tab, one chat's calls one after another.
   A call that answers within QUICK_MS (the site not allowed, the browser asleep or paused, another call in that chat) is
   handed back as it came, so a refusal still reads as one. A turn with no conversation has nobody to wake, so its call
   waits in the call as before. */

type WebextDoor = MountEndpoints["webext"];

export const CHATGPT_IMAGE_TOOL = "chatgpt_image";

// How many images one browser makes at once: each is a tab of its own, and ChatGPT's own limit on images in flight is
// not published, so two, with the rest queued, rather than a refusal from ChatGPT mid-set.
const IMAGES_AT_ONCE = 2;

// How long the call waits for the browser before it is filed as a job: a refusal comes back sooner than this.
const QUICK_MS = 5_000;

export interface ImageJobDeps {
    // The seed a conversation's job is filed with (whose wake it is, as which profile); undefined runs it in the call.
    readonly seedOf: (conversationId: string) => BackgroundJobSeed | undefined;
    // Tests shorten it.
    readonly quickMs?: number;
}

export interface ImageJobSeedDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
    readonly historyRoot: string;
}

/** A conversation's job seed, woken as the conversation's own profile, as a child's report wakes its parent. */
export const imageJobSeeds =
    (deps: ImageJobSeedDeps) =>
    (conversationId: string): BackgroundJobSeed | undefined => {
        const entry = deps.agents.entry(conversationId);
        return entry === undefined ? undefined : { conversationId, profile: conversationProfile(entry), conversations: deps.conversations, historyRoot: deps.historyRoot };
    };

// What the listing says chatgpt_image does at this door, in place of the extension's own words for one blocking call: the
// extension is whatever build the person installed, and this door is what makes the call a job.
export const IMAGE_JOB_DESCRIPTION =
    "Make an image with ChatGPT in the person's own signed-in browser and save it into your sandbox, WITHOUT waiting for it: the call answers within seconds with a job id while ChatGPT works on in a tab of your own window (often several minutes). " +
    "Collect it with the `wait` tool on the `subagents` server (mcp__subagents__wait in most tool lists), target the job id: it answers once the image is saved on the artifacts shelf, with its path and the `chat` id, or with why no image was made. Or end your turn: the job's end wakes this conversation. " +
    `For a set, start them back to back and wait on them together (\`targets\`): ${IMAGES_AT_ONCE} run at once in this browser and the rest queue. For a series in one look, wait for the first, then pass its \`chat\` to the next ones, which run one after another. ` +
    "New chats go into a ChatGPT project of this sandbox's own (project-only memory, so the owner's saved memories and other chats stay out). Needs chatgpt.com allowed in read and act: if it is not, the call says so at once; call ask_access then. " +
    "Prompts: one sentence that starts with the style works best; long, precise prompts make different styles come out alike. Never call again with a prompt already started: that sends it twice. A job that ends saying ChatGPT is still working is collected with chatgpt_read.";

const CallSchema = z.looseObject({
    name: z.literal(CHATGPT_IMAGE_TOOL),
    arguments: z.looseObject({ prompt: z.string().catch(""), chat: z.string().optional().catch(undefined) }).catch({ prompt: "" }),
});
const ListingSchema = z.looseObject({ result: z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }) });
const ResultSchema = z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([]),
    isError: z.boolean().optional().catch(undefined),
});
const ErrorSchema = z.looseObject({ message: z.string() });

type ImageCall = z.infer<typeof CallSchema>["arguments"];

const imageCall = (message: RpcMessage): ImageCall | undefined =>
    message.method === "tools/call" ? CallSchema.safeParse(message.params).data?.arguments : undefined;

// The chat a call continues, as one key whether it was given as an id or as its chatgpt.com address.
const chatKey = (chat: string | undefined): string | undefined => (chat === undefined ? undefined : (/\/c\/([\w-]+)/u.exec(chat)?.[1] ?? chat.trim()));

const withJobDescription = (answer: RpcMessage | undefined): RpcMessage | undefined => {
    const listing = ListingSchema.safeParse(answer);
    if (answer === undefined || !listing.success) {
        return answer;
    }
    const tools = listing.data.result.tools.map((tool) => (tool.name === CHATGPT_IMAGE_TOOL ? { ...tool, description: IMAGE_JOB_DESCRIPTION } : tool));
    return { ...answer, result: { ...listing.data.result, tools } };
};

/** What the browser's answer came to, as a job's end: its words (sealed as the door sealed them) and whether it failed. */
export const imageJobEnd = (answer: RpcMessage | undefined): DaemonJobEnd => {
    if (answer?.error !== undefined) {
        return { ok: false, output: ErrorSchema.safeParse(answer.error).data?.message ?? "The browser answered with an error and no words." };
    }
    const result = ResultSchema.safeParse(answer?.result);
    if (!result.success) {
        return { ok: false, output: "The browser gave no answer to read." };
    }
    const words = result.data.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
    return { ok: result.data.isError !== true, output: words === "" ? "The browser answered with no words." : words };
};

const clock = (): string => `${new Date().toISOString().slice(11, 19)} UTC`;
const images = (count: number): string => `${count} image${count === 1 ? "" : "s"}`;

// The job's output until it ends.
const startedWords = (browser: string, call: ImageCall, began: boolean, ahead: number): string =>
    [
        `ChatGPT image in browser "${browser}": "${oneLine(call.prompt, 200)}"`,
        began ? `Sent to the browser at ${clock()}.` : `Waiting for its turn: ${images(ahead)} ahead of it in this browser (${IMAGES_AT_ONCE} at once).`,
        `If this job ends "lost" (the sandbox restarted meanwhile), the prompt may already have gone: do not send it again. The image may still be on the artifacts shelf, or on its ChatGPT tab in that browser (\`tabs\` lists it).`,
    ].join("\n");

const startedAnswer = (message: RpcMessage, id: string, began: boolean, ahead: number): RpcMessage => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    result: {
        content: [
            {
                type: "text",
                text: [
                    `Started: job "${id}". ChatGPT is making this image in the person's browser${began ? "" : `, once the ${images(ahead)} ahead of it there are done`}, and nothing here waits on it.`,
                    `Collect it with the \`wait\` tool on the \`subagents\` server (mcp__subagents__wait in most tool lists), target "${id}": it answers once the image is saved, with its path and the chat id, or with why no image was made. For several jobs, name them all in \`targets\`: it answers once every one has ended, or early for one that failed.`,
                    "Meanwhile, start the other images you need or do other work; or end your turn, and the job's end wakes this conversation.",
                    "Do not call chatgpt_image with this prompt again: it is already on its way, and a second call sends it twice.",
                ].join("\n"),
            },
        ],
        isError: false,
    },
});

const NOT_YET = Symbol("not yet");

// One chatgpt_image call: queued in its browser's lane, sent, and either answered within QUICK_MS or filed as a job.
const imageInBackground = async (
    door: WebextDoor,
    lanes: JobLanes,
    quickMs: number,
    seed: BackgroundJobSeed,
    request: { readonly target: Parameters<WebextDoor>[0]; readonly message: RpcMessage; readonly call: MountCall; readonly image: ImageCall },
): Promise<RpcMessage | undefined> => {
    const { target, message, call, image } = request;
    const stopped = new AbortController();
    // Nothing waits on the call itself any more: no client's ceiling bounds it (webext-client-ceiling.ts), and the
    // agent's request ending ends nothing.
    const quiet: MountCall = { name: call.name, conversationId: call.conversationId, signal: stopped.signal };
    const ahead = lanes.held(target.id);
    let job: RunningDaemonJob | undefined;
    let began = false;
    const answer = (async (): Promise<RpcMessage | undefined> => {
        const release = await lanes.enter(target.id, chatKey(image.chat), stopped.signal);
        if (release === undefined) {
            return undefined;
        }
        began = true;
        job?.say(`Its turn came at ${clock()}: sent to the browser.`);
        let answered: RpcMessage | undefined;
        try {
            answered = await door(target, message, quiet);
        } catch (error) {
            // The door answers its own failures as JSON-RPC; anything past that still reaches the job as words.
            answered = { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: `The call to the browser failed: ${errorMessage(error)}` } };
        }
        release(imageJobEnd(answered).ok);
        return answered;
    })();
    const quick = await within(answer, quickMs, NOT_YET);
    if (quick !== NOT_YET) {
        return quick;
    }
    const filed = startDaemonJob(seed, {
        command: `${CHATGPT_IMAGE_TOOL} ${JSON.stringify(oneLine(image.prompt, 100))}`,
        description: `ChatGPT image: ${oneLine(image.prompt, 80)}`,
        started: startedWords(target.id, image, began, ahead),
        run: async (signal, running) => {
            job = running;
            whenAborted(signal, () => stopped.abort());
            const answered = await answer;
            return answered === undefined ? { ok: false, output: "Stopped before its turn came: nothing was sent to ChatGPT." } : imageJobEnd(answered);
        },
    });
    // No capture dir could be made: the call is waited on here, as it always was.
    return filed === undefined ? await answer : startedAnswer(message, filed.id, began, ahead);
};

/** The owner's-browser door with chatgpt_image run as a job wherever the turn has a conversation to wake. */
export const chatgptImagesInBackground = (deps: ImageJobDeps, door: WebextDoor): WebextDoor => {
    const lanes = createJobLanes(IMAGES_AT_ONCE);
    const seedFor = (call: MountCall): BackgroundJobSeed | undefined => (call.conversationId === undefined ? undefined : deps.seedOf(call.conversationId));
    return async (target, message, call) => {
        if (message.method === "tools/list") {
            const answer = await door(target, message, call);
            return seedFor(call) === undefined ? answer : withJobDescription(answer);
        }
        const image = imageCall(message);
        const seed = image === undefined ? undefined : seedFor(call);
        if (image === undefined || seed === undefined) {
            return await door(target, message, call);
        }
        return await imageInBackground(door, lanes, deps.quickMs ?? QUICK_MS, seed, { target, message, call, image });
    };
};
