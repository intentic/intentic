// Google's OpenAI-compatible surface takes an image part in a `user` message and nowhere else: anywhere else it answers
// 400 `Invalid content part type: image_url`. The Claude harness's translator puts every image the Read tool returns
// into a `tool` message, so until those images are moved, any trial turn that looked at a screenshot was refused.
// OpenAI's own API restricts tool content the same way, so this normalizes the wire format rather than patching one
// upstream.

// Fields read below are declared, so reads type as `unknown` rather than tripping the index-signature rule; the index
// signature is what lets an unrecognized field survive the rewrite.
type Json = {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly tool_call_id?: unknown;
    readonly type?: unknown;
    readonly text?: unknown;
    readonly messages?: unknown;
} & Record<string, unknown>;

const objectOf = (value: unknown): Json | undefined =>
    typeof value === `object` && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

const stringOf = (value: unknown): string | undefined => (typeof value === `string` ? value : undefined);

const isImagePart = (part: unknown): boolean => objectOf(part)?.type === `image_url`;

const textOf = (part: unknown): string | undefined => {
    const object = objectOf(part);
    return object?.type === `text` ? stringOf(object.text) : undefined;
};

// Left where an image was, so a result that held nothing else is never empty and the model reads on for the picture.
const MOVED_NOTE = `[image moved to the message below]`;

// Names the call a lifted image came from, since it now sits outside the tool result that produced it.
const labelFor = (message: Json): string => {
    const id = stringOf(message.tool_call_id);
    return id === undefined ? `Image from the ${stringOf(message.role) ?? `previous`} message:` : `Image returned by tool call ${id}:`;
};

interface Stripped {
    readonly message: Json;
    readonly images: readonly unknown[];
}

// `tool` content collapses to a string, the only shape OpenAI's tool role has ever taken; other roles keep their parts.
const withoutImages = (message: Json, parts: readonly unknown[]): Stripped => {
    const images = parts.filter(isImagePart);
    const kept = parts.filter((part) => !isImagePart(part));
    if (message.role === `tool`) {
        const text = kept.map(textOf).filter((value): value is string => value !== undefined && value.trim() !== ``);
        return { message: { ...message, content: [...text, MOVED_NOTE].join(`\n\n`) }, images };
    }
    return { message: { ...message, content: [...kept, { type: `text`, text: MOVED_NOTE }] }, images };
};

// The images a message must give up, or undefined for one that keeps everything it has.
const liftedFrom = (entry: unknown): Stripped | undefined => {
    const message = objectOf(entry);
    if (message === undefined || message.role === `user`) {
        return undefined;
    }
    const content = message.content;
    return Array.isArray(content) && content.some(isImagePart) ? withoutImages(message, content) : undefined;
};

const parsedBody = (body: string): { root: Json; messages: readonly unknown[] } | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return undefined;
    }
    const root = objectOf(parsed);
    return root === undefined || !Array.isArray(root.messages) ? undefined : { root, messages: root.messages };
};

// Rewrites a chat-completions body so every image part rides a `user` message. A body with none, and one this can't
// read, come back byte-identical: an unparsable request is the upstream's to complain about, not ours.
export const withImagesInUserMessages = (body: string): string => {
    const parsed = parsedBody(body);
    if (parsed === undefined) {
        return body;
    }
    const rewritten: unknown[] = [];
    let carried: { label: string; part: unknown }[] = [];
    let moved = false;
    const flush = (): void => {
        if (carried.length === 0) {
            return;
        }
        rewritten.push({ role: `user`, content: carried.flatMap(({ label, part }) => [{ type: `text`, text: label }, part]) });
        carried = [];
    };
    for (const entry of parsed.messages) {
        // Tool results must stay adjacent to the assistant message that called them, so carried images wait out a run
        // of them instead of splitting it.
        if (stringOf(objectOf(entry)?.role) !== `tool`) {
            flush();
        }
        const lifted = liftedFrom(entry);
        if (lifted === undefined) {
            rewritten.push(entry);
            continue;
        }
        moved = true;
        rewritten.push(lifted.message);
        carried.push(...lifted.images.map((part) => ({ label: labelFor(lifted.message), part })));
    }
    flush();
    return moved ? JSON.stringify({ ...parsed.root, messages: rewritten }) : body;
};
