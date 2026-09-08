// What an environment overlay (a Dockerfile extending the sandbox image, plus the owner's approved custom section) may
// say, read by three checkers that each re-verify rather than trust the one before:
// - an extension's fragment may only be RUN/ENV
// - the composed file's first instruction must pin the official image
// - a hosted sandbox's overlay is re-checked before any machine exists
// Pure text in, verdict out, no filesystem; ic's Rust twin reads the same shape.

// The marker rebuild executors read runtime privileges from; nothing but the daemon's own code may write it.
const RUNTIME_DIRECTIVE = "intentic:runtime";

const OFFICIAL_SANDBOX_IMAGE = /^ghcr\.io\/intentic\/sandbox:\S+$/;

// The published sandbox image under any tag, the only base an overlay may extend.
export const isOfficialSandboxImage = (ref: string): boolean => OFFICIAL_SANDBOX_IMAGE.test(ref);

interface OverlayLine {
    readonly raw: string;
    // `body` is a line inside a `-continued instruction, which carries no keyword of its own.
    readonly kind: "blank" | "comment" | "instruction" | "body";
}

// Continuation-aware: a ` at the end of any line, comments included, makes the next line a body line.
const overlayLines = (content: string): OverlayLine[] => {
    let continued = false;
    return content.split("\n").map((raw) => {
        const line = raw.trim();
        const wasContinued = continued;
        continued = line.endsWith("\\");
        const kind = line === "" ? "blank" : line.startsWith("#") ? "comment" : wasContinued ? "body" : "instruction";
        return { raw, kind };
    });
};

const FROM = /^from\s+(\S+)/i;
const RUN_OR_ENV = /^(run|env)\s/i;

// An extension fragment may only install and set variables (RUN/ENV): FROM is refused since the daemon owns the base
// pin, and the runtime directive is refused anywhere, even in a comment, since an out-of-band executor greps for it.
export const invalidExtensionFragment = (content: string): string | undefined => {
    for (const { raw, kind } of overlayLines(content)) {
        if (raw.includes(RUNTIME_DIRECTIVE)) {
            return raw;
        }
        if (kind === "instruction" && !RUN_OR_ENV.test(raw.trim())) {
            return raw;
        }
    }
    return undefined;
};

// The image a composed overlay extends: the first instruction, when it is a FROM.
export const overlayBase = (content: string): string | undefined => {
    const first = overlayLines(content).find((line) => line.kind === "instruction");
    return first === undefined ? undefined : FROM.exec(first.raw.trim())?.[1];
};

// Whether the overlay's first instruction pins it to the official sandbox image.
export const hasOfficialBase = (content: string): boolean => {
    const base = overlayBase(content);
    return base !== undefined && isOfficialSandboxImage(base);
};

// A whole composed overlay: one leading FROM on the official image, then RUN and ENV only. Comments pass (the runtime
// directive included, since it's meant to be read from here); no instruction at all is refused.
export const lintOverlay = (content: string): string | undefined => {
    let first = true;
    for (const { raw, kind } of overlayLines(content)) {
        if (kind !== "instruction") {
            continue;
        }
        const line = raw.trim();
        if (first) {
            first = false;
            const base = FROM.exec(line)?.[1];
            if (base === undefined || !isOfficialSandboxImage(base)) {
                return raw;
            }
            continue;
        }
        if (!RUN_OR_ENV.test(line)) {
            return raw;
        }
    }
    return first ? "" : undefined;
};

// Rewrites only the first FROM; everything else stays byte-identical. The hash an executor checks is over the
// owner-approved content, not this rewrite, so it stays the reviewed one across bases.
export const rewriteOverlayBase = (content: string, base: string): string => {
    let done = false;
    return overlayLines(content)
        .map(({ raw, kind }) => {
            if (done || kind !== "instruction") {
                return raw;
            }
            done = true;
            return FROM.test(raw.trim()) ? raw.replace(FROM, `FROM ${base}`) : raw;
        })
        .join("\n");
};
