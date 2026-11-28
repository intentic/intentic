import { declaredReachOf, extensionIdOf } from "@intentic/extension-manifest";
import {
    EXTENSION_SIGN_PER_MINUTE,
    ExtensionIdentitySignSchema,
    type ExtensionIdentitySigned,
} from "@intentic/sandbox-contract/extension-protocol";
import { canonicalBytes, EXTENSION_SIGN_PAYLOAD_MAX_BYTES, extensionSignDomain, extensionSignProblem, hybridVerify } from "@intentic/sandbox-contract/s2s";
import type { HybridSig, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";

// (2026-11-28) THIS SANDBOX'S IDENTITY for an extension's own code (`api.identity`, the contract's extension-protocol.ts):
// its public document, and a signature as this sandbox over a record of the extension's own. The key never leaves the
// daemon: the door signs through the identity service's own seam (services.s2sIdentity.sign), under a domain naming the
// extension from its token and the purpose it asked (`ext:<publisher.name>/<purpose>`), so the signature can never pass
// as one of the core's (an identity document, an envelope, a session). Handing an extension a delegated key instead was
// rejected: a key once handed out cannot be taken back by the daemon (docs/architecture/messages.md, Decisions).
// Reached by every extension token undeclared in `permissions.daemon` (extension-manifest's EXTENSION_OWN_ROUTES); the
// sign door also checks `permissions.identity` declares `sign`.

type OwnCaller = (c: Context<AppEnv>) => Promise<InstalledExtension | Response>;

const MINUTE_MS = 60_000;

// A body past this many bytes is refused before it is parsed, counted as it arrives: the payload's canonical cap with
// room for its spelling (escapes, whitespace) and the purpose.
const SIGN_BODY_MAX_BYTES = EXTENSION_SIGN_PAYLOAD_MAX_BYTES * 2 + 1024;

// One fixed minute's count per extension: cheap, and enough to keep a looping backend from spending the daemon on
// ML-DSA signatures.
const signWindows = () => {
    const windows = new Map<string, { start: number; count: number }>();
    return (extension: string, now: number): number | undefined => {
        const window = windows.get(extension);
        if (window === undefined || now - window.start >= MINUTE_MS) {
            windows.set(extension, { start: now, count: 1 });
            return undefined;
        }
        window.count += 1;
        return window.count > EXTENSION_SIGN_PER_MINUTE ? Math.ceil((window.start + MINUTE_MS - now) / 1000) : undefined;
    };
};

export const createExtensionIdentityDoors = (services: Pick<Services, "s2sIdentity" | "logger">, ownCaller: OwnCaller, now: () => number = Date.now) => {
    const admit = signWindows();

    // Signs under the current key set and answers it with the document that verifies it. A rotation between the two
    // reads is met by signing again once with the key the document now names.
    const signed = async (domain: ReturnType<typeof extensionSignDomain>, bytes: Uint8Array): Promise<{ sig: HybridSig; document: SandboxIdentity }> => {
        for (let attempt = 0; ; attempt++) {
            const sig = await services.s2sIdentity.sign(domain, bytes);
            const document = await services.s2sIdentity.document();
            if (hybridVerify(domain, bytes, sig, document.keys) || attempt > 0) {
                return { sig, document };
            }
        }
    };

    return {
        // The public document, as GET /s2s/identity serves it to anyone.
        document: async (c: Context<AppEnv>): Promise<Response> => {
            const extension = await ownCaller(c);
            if (extension instanceof Response) {
                return extension;
            }
            return c.json(await services.s2sIdentity.document());
        },

        // `{ purpose, payload }` signed as this sandbox: 403 undeclared, 400 for a purpose outside its pattern or a body
        // that is not `{ purpose, payload }` JSON, 413 past the cap, 429 past the minute's count.
        sign: async (c: Context<AppEnv>): Promise<Response> => {
            const extension = await ownCaller(c);
            if (extension instanceof Response) {
                return extension;
            }
            if (!declaredReachOf(extension.manifest.permissions).identity.includes("sign")) {
                return c.json({ error: `extension "${extension.id}" did not declare permissions.identity ["sign"], so it signs nothing as this sandbox` }, 403);
            }
            // Counted as it arrives, so a chunked body is held to the cap as a declared one is.
            const read = await readBoundedJson(c.req.raw, SIGN_BODY_MAX_BYTES);
            if (read.kind === "tooLarge") {
                return c.json({ error: `a record to sign is at most ${EXTENSION_SIGN_PAYLOAD_MAX_BYTES} bytes of canonical JSON` }, 413);
            }
            const asked = ExtensionIdentitySignSchema.safeParse(read.kind === "ok" ? read.value : undefined);
            if (!asked.success) {
                return c.json({ error: `not a record to sign: the body is { purpose, payload }, the payload any JSON value` }, 400);
            }
            const identity = extensionIdOf(extension.manifest);
            const problem = extensionSignProblem(identity, asked.data.purpose);
            if (problem !== undefined) {
                return c.json({ error: problem }, 400);
            }
            const bytes = canonicalBytes(asked.data.payload);
            if (bytes.length > EXTENSION_SIGN_PAYLOAD_MAX_BYTES) {
                return c.json({ error: `a record to sign is at most ${EXTENSION_SIGN_PAYLOAD_MAX_BYTES} bytes of canonical JSON; this one is ${bytes.length}` }, 413);
            }
            const retryAfter = admit(identity, now());
            if (retryAfter !== undefined) {
                c.header("retry-after", String(retryAfter));
                return c.json({ error: `extension "${identity}" asked for more than ${EXTENSION_SIGN_PER_MINUTE} signatures this minute` }, 429);
            }
            const domain = extensionSignDomain(identity, asked.data.purpose);
            const { sig, document } = await signed(domain, bytes);
            services.logger.debug({ extension: identity, domain, bytes: bytes.length }, "an extension had a record signed as this sandbox");
            return c.json({ domain, sig, fingerprint: document.fingerprint, document } satisfies ExtensionIdentitySigned);
        },
    };
};
