import type { StepAnswer } from "@intentic/site-kits/chatgpt";

// The extension's own way of giving ChatGPT a file (chrome-host.ts): the bytes travel into the page in slices and are
// put into the composer's file input there (page/media-driver.ts); the sandbox's browser sets the input's files itself.
// The step is injected on its own by executeScript, which serializes and re-parses that one function inside the page,
// so it refers to nothing outside itself.

// Holds the composer's own file input for putFile (page/media-driver.ts), where findFileInput would hold one an agent
// aimed at by ref: the input that takes `type`, else the first. The pin lives on the same isolated world's window.
export const pinFileInputStep = (selector: string, pin: string, name: string, type: string): StepAnswer => {
    const inputs = Array.from(document.querySelectorAll(selector)).filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && !el.disabled);
    const lower = name.toLowerCase();
    const takes = (input: HTMLInputElement): boolean => {
        const accept = input.accept.split(",").map((token) => token.trim().toLowerCase()).filter((token) => token !== "");
        return (
            accept.length === 0 ||
            accept.some((token) => (token.startsWith(".") ? lower.endsWith(token) : token.endsWith("/*") ? type.startsWith(token.slice(0, -1)) : token === type))
        );
    };
    const input = inputs.find(takes);
    window.intenticFilePin = undefined;
    if (input === undefined) {
        return {
            kind: "answer",
            ok: false,
            message: inputs.length === 0 ? `ChatGPT's page has no file input to attach to.` : `ChatGPT's file input does not take ${type} (${name}).`,
        };
    }
    window.intenticFilePin = { pin, input };
    return { kind: "answer", ok: true, message: "" };
};
