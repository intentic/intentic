// What runs inside ChatGPT's tab to find or make a sandbox's project (project.ts), one step per call, on the helpers
// page-hands.ts installed. Each step is injected on its own and carries its helpers whole, so `typeInto` is written into
// both steps that type rather than shared (steps.ts says why). Every lookup it uses is in site.ts, and every one of
// them is a guess until seen on the real page.
import type { StepAnswer } from "./steps.js";

// The sidebar's link to the project called `name`: its address, or not found.
export const findProjectStep = (name: string): StepAnswer | null => {
    const reading = window.intenticChatgpt?.reading;
    if (reading === undefined) {
        return null;
    }
    const link = Array.from(document.querySelectorAll("a[href]")).find((el) => reading.squash(reading.textOf(el)) === name || reading.nameOf(el) === name);
    const href = link?.getAttribute("href");
    return href === null || href === undefined
        ? { kind: "answer", ok: false, message: `No project called "${name}" in ChatGPT's sidebar.` }
        : { kind: "answer", ok: true, message: new URL(href, location.href).href };
};

// What making a project answers: whether project-only memory was chosen besides.
export interface ProjectMade extends StepAnswer {
    readonly memory: boolean;
}

// Makes a project called `name` with its memory set to project-only where the dialog offers that choice. Answers ok
// once "Create project" was pressed, with `memory` saying whether project-only memory was chosen. The worker then waits
// for the tab to arrive at the project's own address.
export const createProjectStep = async (name: string, waitMs: number): Promise<ProjectMade | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const { site, locate, nameOf } = reading;
    let memory = false;
    const answer = (ok: boolean, message: string): ProjectMade => ({ kind: "answer", ok, message, memory });
    // Into a plain input the way React notices (the native setter, then `input`); into a rich editor by insertText.
    const typeInto = (box: Element, typed: string): void => {
        if (box instanceof HTMLElement) {
            box.focus();
        }
        if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set?.call(box, typed);
            box.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            document.execCommand("insertText", false, typed);
        }
    };
    const opener = locate(site.newProject);
    if (opener === undefined) {
        return answer(false, `ChatGPT's "New project" button is not on the page.`);
    }
    acting.press(opener);
    const box = await acting.until(() => locate(site.projectName), waitMs);
    if (box === undefined) {
        return answer(false, `ChatGPT's new-project dialog did not open, or has no name box.`);
    }
    typeInto(box, name);
    // The memory choice sits behind the dialog's settings button; as a menu radio or a plain radio.
    const settings = locate(site.projectSettings);
    if (settings !== undefined) {
        acting.press(settings);
        const choice = await acting.until(() => locate(site.projectOnlyMemory) ?? locate({ ...site.projectOnlyMemory, role: "radio" }), waitMs);
        if (choice !== undefined) {
            acting.press(choice);
            memory = true;
        }
    }
    const enabled = (el: Element): boolean => !(el instanceof HTMLButtonElement && el.disabled) && el.getAttribute("aria-disabled") !== "true";
    const create = await acting.until(() => reading.findAll(site.createProject).find(enabled), waitMs);
    if (create === undefined) {
        return answer(false, `ChatGPT's "Create project" button did not become pressable${box instanceof HTMLInputElement ? ` (the name box reads "${box.value}")` : ""}.`);
    }
    acting.press(create);
    return answer(true, `Pressed "${nameOf(create)}".`);
};

// Sets a project's instructions, which stand in for the owner's own custom instructions inside it.
export const instructionsStep = async (text: string, waitMs: number): Promise<StepAnswer | null> => {
    const reading = window.intenticChatgpt?.reading;
    const acting = window.intenticChatgpt?.acting;
    if (reading === undefined || acting === undefined) {
        return null;
    }
    const { site, locate } = reading;
    // Into a plain input the way React notices (the native setter, then `input`); into a rich editor by insertText.
    const typeInto = (box: Element, typed: string): void => {
        if (box instanceof HTMLElement) {
            box.focus();
        }
        if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set?.call(box, typed);
            box.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            document.execCommand("insertText", false, typed);
        }
    };
    const opener = await acting.until(() => locate(site.projectInstructions), waitMs);
    if (opener === undefined) {
        return { kind: "answer", ok: false, message: `The project's page has no "Instructions" button.` };
    }
    acting.press(opener);
    const box = await acting.until(() => locate(site.instructionsBox), waitMs);
    if (box === undefined) {
        return { kind: "answer", ok: false, message: `The project's instructions dialog did not open.` };
    }
    typeInto(box, text);
    const save = await acting.until(() => locate(site.save), waitMs);
    if (save === undefined) {
        return { kind: "answer", ok: false, message: `The project's instructions dialog has no "Save" button.` };
    }
    acting.press(save);
    const closed = await acting.until(() => locate(site.instructionsBox) === undefined, waitMs);
    return closed === true
        ? { kind: "answer", ok: true, message: `Saved.` }
        : { kind: "answer", ok: false, message: `The instructions dialog stayed open after "Save".` };
};
