import { boolean, object, record, string } from "zod";
import { type SandboxKey, sandboxKey, sandboxName, store } from "../../store.js";
import { go, step, untilAddress } from "./drive.js";
import { createProjectStep, findProjectStep, instructionsStep } from "./project-steps.js";
import { readyStep } from "./steps.js";
import { CHATGPT_SITE } from "./site.js";

// WHERE A SANDBOX'S CHATS LIVE (2026-11-14): one ChatGPT project per sandbox, "Intentic · <sandbox>", made on first use
// with project-only memory and instructions of its own. Until then every chat was temporary and unpersonalized, which
// kept the owner's memory out of the answer but also turned off apps and connectors, and could not be opened again
// once its tab moved on (OpenAI's "Temporary chat" help page, Nov 2026). Inside a project with project-only memory the
// owner's saved memories and outside chats are not referenced, and the project's instructions stand in for their custom
// instructions, while every tool, connected app and the chat's own address keep working. Rejected: regular chats
// (the owner's memory and history shape the answer) and one project shared by every sandbox (one sandbox's chats would
// become another's context).

export interface Project {
    readonly url: string;
    readonly name: string;
    // Project-only memory was chosen when this kit made it; false when it could not be, or it was found already there.
    readonly memory: boolean;
    readonly instructions: boolean;
}

export interface ProjectTiming {
    readonly readyMs: number;
    readonly stepMs: number;
}

// What the project's instructions say, in place of the owner's custom instructions.
const INSTRUCTIONS =
    "Requests in this project come from an AI agent working for the account's owner through Intentic. Answer each request as written, from what it says and what this project holds, without drawing on the owner's personal context.";

// Remembered per sandbox in chrome.storage.local, which outlives a browser restart (a project, unlike a tab, does).
const KEY = "kit:chatgpt-project";
const ProjectSchema = object({ url: string(), name: string(), memory: boolean(), instructions: boolean() });
const RememberedSchema = record(string(), ProjectSchema.nullable().catch(null));

const rememberedAll = async (): Promise<Record<string, Project | null>> => {
    const parsed = RememberedSchema.safeParse((await chrome.storage.local.get([KEY]))[KEY]);
    return parsed.success ? parsed.data : {};
};

const remember = async (from: SandboxKey, project: Project): Promise<void> => {
    await chrome.storage.local.set({ [KEY]: { ...(await rememberedAll()), [sandboxKey(from)]: project } });
};

// The sandbox's project as last seen, to tell its chats from the account's others; undefined before it has one.
export const rememberedProject = async (from: SandboxKey): Promise<Project | undefined> => (await rememberedAll())[sandboxKey(from)] ?? undefined;

const projectNameFor = async (from: SandboxKey): Promise<string> => {
    const sandbox = await store.sandbox(from);
    return `Intentic · ${sandbox === undefined ? new URL(from).host : sandboxName(sandbox)}`;
};

const onProject = (url: URL): boolean => url.host === CHATGPT_SITE.host && CHATGPT_SITE.projectPath.test(url.pathname);

// Takes the tab to a project's page and answers whether it arrived there with a message box to start a chat in.
const arrive = async (tabId: number, url: string, timing: ProjectTiming): Promise<boolean> => {
    await go(tabId, url);
    const ready = await step(tabId, readyStep, [timing.readyMs]);
    const at = await untilAddress(tabId, onProject, 0);
    return ready?.composer === true && !ready.signedOut && at !== undefined;
};

interface ProjectFound {
    readonly project?: Project | undefined;
    // What the agent is told about it: made just now, found, or why there is none.
    readonly note: string;
}

const made = async (from: SandboxKey, tabId: number, name: string, timing: ProjectTiming): Promise<ProjectFound> => {
    const created = await step(tabId, createProjectStep, [name, timing.stepMs]);
    if (created?.ok !== true) {
        return { note: `The ChatGPT project "${name}" could not be made: ${created?.message ?? "the page did not answer"}.` };
    }
    const url = await untilAddress(tabId, onProject, timing.readyMs);
    if (url === undefined) {
        return { note: `ChatGPT did not open the new project "${name}" after "Create project", so it may or may not exist now.` };
    }
    const { memory } = created;
    const instructions = (await step(tabId, instructionsStep, [INSTRUCTIONS, timing.stepMs]))?.ok === true;
    const project: Project = { url, name, memory, instructions };
    await remember(from, project);
    const unset = [memory ? "" : "its memory could not be set to project-only", instructions ? "" : "its instructions could not be set"].filter((part) => part !== "");
    const warning =
        unset.length === 0
            ? ""
            : ` Note: ${unset.join(", and ")}, so the owner's own memory or custom instructions may reach its answers. Tell the owner: in ChatGPT, open the project's settings and choose Memory: Project-only.`;
    return { project, note: `Made the ChatGPT project "${name}" for this sandbox's chats, with ${memory ? "project-only memory" : "the account's default memory"}.${warning}` };
};

// The sandbox's project, with the tab on its page ready to start a chat; made when it does not exist yet. Without one
// (ChatGPT changed its pages), `project` is undefined and the note says why, and the caller falls back.
export const ensureProject = async (from: SandboxKey, tabId: number, timing: ProjectTiming): Promise<ProjectFound> => {
    const name = await projectNameFor(from);
    const known = (await rememberedAll())[sandboxKey(from)];
    if (known !== null && known !== undefined && (await arrive(tabId, known.url, timing))) {
        return { project: known, note: "" };
    }
    await go(tabId, CHATGPT_SITE.home);
    await step(tabId, readyStep, [timing.readyMs]);
    const found = await step(tabId, findProjectStep, [name]);
    if (found?.ok === true && (await arrive(tabId, found.message, timing))) {
        const project: Project = { url: found.message, name, memory: known?.memory ?? false, instructions: known?.instructions ?? false };
        await remember(from, project);
        const memory = project.memory ? "" : ` Its memory setting was not checked: if the owner's memory should stay out, tell them to set its Memory to Project-only.`;
        return { project, note: `Using the ChatGPT project "${name}".${memory}` };
    }
    await go(tabId, CHATGPT_SITE.home);
    await step(tabId, readyStep, [timing.readyMs]);
    return await made(from, tabId, name, timing);
};
