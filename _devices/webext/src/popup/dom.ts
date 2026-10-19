import type { PopupCommand } from "../background/messages.js";

// The popup's few DOM helpers, shared by its sections (popup.ts, passwords-section.ts): no framework, since the popup
// opens on every click of the toolbar button and has to draw at once.

export const send = async <T>(command: PopupCommand): Promise<T> =>
    // SAFETY: the worker answers each popup command with that command's own shape (main.ts `handle`).
    (await chrome.runtime.sendMessage(command)) as T;


export const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
    // SAFETY: every id asked for is one popup.html holds, as the element type it is asked as.
    document.getElementById(id) as T;


export const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { class?: string; text?: string; title?: string } = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (props.class !== undefined) {
        node.className = props.class;
    }
    if (props.text !== undefined) {
        node.textContent = props.text;
    }
    if (props.title !== undefined) {
        node.title = props.title;
    }
    node.append(...children);
    return node;
};


// Stroke icons on a 16-unit grid; `fill` for the one solid shape.
const ICONS = {
    pause: { d: "M5.5 3.5v9M10.5 3.5v9" },
    play: { d: "M5 3.4 12.4 8 5 12.6z", fill: true },
    remove: { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" },
    paused: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM6.4 5.6v4.8M9.6 5.6v4.8" },
    offline: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM3.6 3.6l8.8 8.8" },
    info: { d: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 1 0 8 1.8zM8 7.3v4M8 4.8v.1" },
    done: { d: "M3 8.5 6.5 12 13 4.5" },
    failed: { d: "M4 4l8 8M12 4l-8 8" },
} as const;

export type IconName = keyof typeof ICONS;

export const icon = (name: IconName): SVGSVGElement => {
    const spec: { d: string; fill?: boolean } = ICONS[name];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", spec.d);
    path.setAttribute("fill", spec.fill === true ? "currentColor" : "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
};


export const button = (
    label: string,
    weight: "primary" | "plain" | "quiet",
    onClick: (event: MouseEvent) => void,
    size: "regular" | "small" = "regular",
): HTMLButtonElement => {
    const node = h("button", { class: ["btn", weight === "plain" ? "" : weight, size === "small" ? "small" : ""].filter(Boolean).join(" ") });
    node.type = "button";
    node.append(label);
    node.addEventListener("click", onClick);
    return node;
};


export const show = (node: HTMLElement, visible: boolean): void => {
    node.hidden = !visible;
};

// A message under a form or card, cleared by the next attempt.
export const say = (node: HTMLElement, message: string | undefined): void => {
    node.textContent = message ?? "";
    show(node, message !== undefined);
};
