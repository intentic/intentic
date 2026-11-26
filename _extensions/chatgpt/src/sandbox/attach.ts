import type { ToolArguments, ToolResult } from "@intentic/extension-api";
import { KitRefusal, type PageStep, pageCall } from "../kit/index.js";
import { installActing, installAsking, installReading, installWatching, removeHelpers } from "../kit/chatgpt/page-hands.js";
import { CHATGPT_PAGE, CHATGPT_SITE } from "../kit/chatgpt/site.js";
import { markStep, type StepAnswer, unmarkStep } from "../kit/chatgpt/steps.js";
import { choosingFile, firstLineOf } from "./page.js";
import type { ShelfFile } from "./shelf.js";

// FILES INTO CHATGPT THE WAY AN AGENT PUTS ONE IN (2026-11-26): a click on the composer's "Add files and more" button
// and, when that opens a menu, on its "Add photos & files" item, which opens the page's file chooser, answered with
// `browser_file_upload`. A real pointer click is what a file chooser opens for (a script's `click()` has no user
// activation), and an extension's browser calls are the page's own tools: `browser_run_code_unsafe`, which set the
// input's files from Playwright's process while the kit lived in the daemon, reaches every site's cookies and is not one
// of them. Each element is found by the kit's own lookups in one step, marked, and clicked by the mark.

// The mark a step puts on the element to click, and the selector the click names it by.
const MARK = "data-intentic-chatgpt-click";
const MARKED = `[${MARK}]`;

export interface AttachDeps {
    readonly call: (tool: string, args: ToolArguments) => Promise<ToolResult>;
    readonly run: <Result>(step: PageStep<Result>) => Promise<Result | undefined>;
    // How long a step waits for what it looks for.
    readonly stepMs: number;
}

// The helpers every step reads, as the engine installs them (drive.ts).
const HELPERS = [
    pageCall(installReading, [CHATGPT_PAGE, CHATGPT_SITE.host]),
    pageCall(installActing, []),
    pageCall(installWatching, []),
    pageCall(installAsking, []),
];
const CLEANUP = pageCall(removeHelpers, []);

const stepOf = <Args extends unknown[]>(func: (...args: Args) => Promise<StepAnswer | null> | StepAnswer | null, args: Args): PageStep<StepAnswer> => ({
    helpers: HELPERS,
    step: pageCall(func, args),
    cleanup: CLEANUP,
});

const FIX = "If it says the same again, tell the owner the ChatGPT kit needs fixing.";

// The marked element clicked; its answer says whether the page now waits on a file chooser.
const clickMarked = async (deps: AttachDeps, element: string): Promise<ToolResult> => await deps.call("browser_click", { element, target: MARKED });

// Marks `target`, or refuses saying why it is not there.
const mark = async (deps: AttachDeps, target: "toolsMenu" | "uploadItem"): Promise<void> => {
    const marked = await deps.run(stepOf(markStep, [target, MARK, deps.stepMs]));
    if (marked?.ok !== true) {
        throw new KitRefusal(`Nothing was sent: ${marked?.message ?? "ChatGPT's page did not answer"} ${FIX}`);
    }
};

// Opens the page's file chooser: the tools button, then the menu's upload item when the button opened a menu.
const openChooser = async (deps: AttachDeps, file: ShelfFile): Promise<void> => {
    await mark(deps, "toolsMenu");
    if (choosingFile(await clickMarked(deps, "ChatGPT's Add files and more button"))) {
        return;
    }
    try {
        await mark(deps, "uploadItem");
    } catch (error) {
        // The menu is left closed behind a refusal, as the person would close it.
        await deps.call("browser_press_key", { key: "Escape" });
        throw error;
    }
    const clicked = await clickMarked(deps, "the menu's Add photos & files item");
    if (!choosingFile(clicked)) {
        throw new KitRefusal(`Nothing was sent: ChatGPT's page opened no file chooser for ${file.name} (${firstLineOf(clicked)}). ${FIX}`);
    }
};

/** Each file put into ChatGPT's composer through the page's own file chooser, one at a time. */
export const attachThroughChooser = async (deps: AttachDeps, files: readonly ShelfFile[]): Promise<void> => {
    for (const file of files) {
        await openChooser(deps, file);
        const uploaded = await deps.call("browser_file_upload", { paths: [file.path] });
        if (uploaded.isError === true) {
            throw new KitRefusal(`Nothing was sent: ${file.name} did not reach ChatGPT's file input (${firstLineOf(uploaded)}). ${FIX}`);
        }
    }
    if (files.length > 0) {
        await deps.run(stepOf(unmarkStep, [MARK]));
    }
};
