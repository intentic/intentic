/* WHAT AN ENVIRONMENT OVERLAY MAY SAY, read the same way by everyone who handles one.
 *
 * An overlay is the Dockerfile that extends the sandbox image for one sandbox: a pinned FROM, the enabled
 * capabilities' fragments, and the custom section the owner approved. Three readers apply the same grammar
 * at three trust levels, and none of them may trust the one before:
 *   • the daemon admits an EXTENSION's fragment only if it is RUN/ENV (capabilities/handlers/extension.ts at
 *     install, environment/fragment-sources.ts again at compose, in case the checkout changed);
 *   • the daemon pins the composed file's first instruction to the official image (environment.ts);
 *   • the platform builds a HOSTED sandbox's overlay on a machine of its own, from content that reached it
 *     through an agent-writable volume and a browser, so it re-checks all of it before any machine exists.
 * Text in, verdict out. No filesystem and no services, so the platform imports this the way it imports
 * tunnel-ids, and the ic binary's Rust twin (recreate.rs `overlay_base`, runner.rs) reads the same shape. */

// The marker the rebuild executors read runtime privileges from (`# intentic:runtime --privileged`, the
// docker run flag it becomes is allowlisted there). A fragment that can be written by anything but the
// daemon's own code must not carry it, in a comment or anywhere else.
const RUNTIME_DIRECTIVE = "intentic:runtime";

const OFFICIAL_SANDBOX_IMAGE = /^ghcr\.io\/intentic\/sandbox:\S+$/;

// The published sandbox image under any tag, the only base an overlay may extend.
export const isOfficialSandboxImage = (ref: string): boolean => OFFICIAL_SANDBOX_IMAGE.test(ref);

interface OverlayLine {
    readonly raw: string;
    // `body` is a line inside a `\`-continued instruction, which carries no keyword of its own.
    readonly kind: "blank" | "comment" | "instruction" | "body";
}

// Continuation-aware: a `\` at the end of any line, comments included, makes the next line a body line.
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

/* An extension fragment may install and set variables, and nothing else. FROM is refused because the daemon
 * owns the base pin; every other instruction because there is no build context to COPY from and nothing an
 * extension has any business doing to USER, ENTRYPOINT or EXPOSE; and the runtime directive anywhere,
 * because an out-of-band executor greps for it and a comment is exactly where it would hide. Answers the
 * offending line, or undefined when the fragment is clean. */
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

/* A whole composed overlay, as an executor that did not compose it must read it: one leading FROM on the
 * official image, then RUN and ENV only. Comments pass, the runtime directive included, since a composed
 * overlay is where the daemon's own capability fragments put it and the executor that honours it (ic) reads
 * it from there; an executor that cannot honour it (a VM is already privileged) ignores it. Answers the
 * offending line, or undefined. An overlay with no instruction at all is refused: there is nothing to build. */
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

/* The same overlay on a different base: the first FROM rewritten, everything else byte-identical. An
 * executor applies an approved recipe on the base IT runs (a newer release than the one the daemon composed
 * against, a rollback pin), and hashes the content the owner approved rather than this rewrite, so the
 * environment hash stays the reviewed one. Content whose first instruction is not a FROM is returned as is. */
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
