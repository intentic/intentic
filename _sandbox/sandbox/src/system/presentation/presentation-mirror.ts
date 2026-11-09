import { presentationDigest } from "@intentic/api-contract/ingress";
import { serialLock, SingleFlight } from "@intentic/base/async";
import type { Logger } from "pino";
import { filePresentationStore, type HeldPresentation, type PresentationStore } from "./presentation-store.js";
import type { Config } from "../../env.config.js";
import type { AnnounceListeners } from "../boot/announce.js";
import { opt } from "../../opt.js";
import { type PresentationAnswer, presentationOf, type SandboxPresentation } from "../platform-client.js";

/* THE SANDBOX'S COPY OF ITS OWN NAME AND LOGO (2026-11-09). The platform decides both and is the only place a person
 * changes them; the sandbox keeps the copy it last heard (presentation-store.ts), so a client that reaches it directly
 * still shows them while the platform is down. It hears them:
 *   - when an accepted announce's `presentationDigest` differs from its copy's digest (the hourly heartbeat, or a start),
 *     which costs one ask per change rather than a 150 KB logo on every announce;
 *   - when a member asks it to refresh (POST /system/presentation/refresh), which the editor does after a rename;
 *   - when an export asks the platform for its bundle, and when an adoption it sent the platform succeeds.
 * Only the platform's own 200 changes the copy: a platform that cannot be reached, refuses, or answers something that is
 * not one leaves it as it was, since keeping the last name is the point. An answer with an empty name and no logo is the
 * platform's word that there is none, and removes it. */

export interface PresentationMirror {
    // The copy held, as GET /system/presentation answers it.
    readonly held: () => Promise<HeldPresentation | undefined>;
    // An accepted announce's digest: asks the platform only when it is not the held copy's.
    readonly announced: (digest: string) => Promise<void>;
    // Asks the platform now. `refreshed` false: it could not be reached or refused, and `presentation` is the copy held.
    readonly refresh: () => Promise<{ readonly presentation: HeldPresentation | undefined; readonly refreshed: boolean }>;
    // What an adoption sent the platform, once it took it: the browser's memory of the name and logo, then the row's.
    readonly adopted: (sent: { readonly name?: string; readonly image?: string }) => Promise<void>;
    // The platform's answer as a bundle carries it, kept on the way. Never a throw: an export must not fail over it.
    readonly forExport: () => Promise<SandboxPresentation | undefined>;
}

export interface PresentationMirrorDeps {
    readonly store: PresentationStore;
    // The platform's answer to the presentation route (platform-client.ts askPresentation): undefined for no news.
    readonly ask: () => Promise<PresentationAnswer | undefined>;
    // Says a copy that could not be kept on the export's way, which still packs what the platform said.
    readonly logger: Pick<Logger, "warn">;
    readonly now?: () => Date;
}

type Asked = { readonly answer: PresentationAnswer; readonly held: HeldPresentation | undefined } | { readonly answer: undefined };

export const createPresentationMirror = ({ store, ask, logger, now = () => new Date() }: PresentationMirrorDeps): PresentationMirror => {
    // One change to the copy at a time, in the order they were asked, so an adoption's copy and the announce right after
    // it never land the wrong way round.
    const changes = serialLock();
    // One ask of the platform at a time: an announce and a refresh arriving together share it.
    const flight = new SingleFlight<"ask", Asked>();

    // The digest comes with the platform's answer; computed here for one that carries none (an adoption's copy, an older
    // platform's answer), by the same rule, so the next announce's digest matches it when nothing changed.
    const keepCopy = async (name: string, image: string | undefined, digest: string | undefined): Promise<HeldPresentation> =>
        changes(async () =>
            store.keep({ name, ...opt("image", image), digest: digest ?? (await presentationDigest(name, image)), at: now().toISOString() }),
        );

    const keepAnswer = async (answer: PresentationAnswer): Promise<HeldPresentation | undefined> => {
        const image = answer.image === "" ? undefined : answer.image;
        if (answer.name === "" && image === undefined) {
            await changes(() => store.forget());
            return undefined;
        }
        return keepCopy(answer.name, image, answer.digest);
    };

    const askAndKeep = (): Promise<Asked> =>
        flight.run("ask", async () => {
            const answer = await ask();
            return answer === undefined ? { answer } : { answer, held: await keepAnswer(answer) };
        });

    return {
        held: () => store.read(),
        // Read behind the changes in flight, so an adoption's copy kept just before is the one compared.
        announced: async (digest) => {
            if ((await changes(() => store.read()))?.digest === digest) {
                return;
            }
            await askAndKeep();
        },
        refresh: async () => {
            const asked = await askAndKeep();
            return asked.answer === undefined ? { presentation: await store.read(), refreshed: false } : { presentation: asked.held, refreshed: true };
        },
        // A copy needs a name: an adoption that sent only a logo leaves the announce that follows it to ask.
        adopted: async ({ name, image }) => {
            if (name === undefined || name === "") {
                return;
            }
            await keepCopy(name, image === "" ? undefined : image, undefined);
        },
        forExport: async () => {
            const answer = await ask();
            if (answer !== undefined) {
                await keepAnswer(answer).catch((error: Error) => logger.warn({ err: error }, "presentation: the platform's answer for an export was not kept"));
            }
            return presentationOf(answer);
        },
    };
};

// The daemon's own mirror, on its history volume, and what its announcer hands it: a digest to compare, an adoption's
// name and logo to keep. A copy that could not be kept is said and the announce goes on (composition.ts).
export interface DaemonPresentation {
    readonly mirror: PresentationMirror;
    readonly listeners: Required<Pick<AnnounceListeners, "presentationDigest" | "adopted">>;
}

export const daemonPresentation = (
    config: Pick<Config, "historyRoot">,
    ask: () => Promise<PresentationAnswer | undefined>,
    logger: Pick<Logger, "warn">,
): DaemonPresentation => {
    const mirror = createPresentationMirror({ store: filePresentationStore(config.historyRoot), ask, logger });
    const kept = (what: string) => (error: Error) => logger.warn({ err: error }, `${what}: the sandbox's name and logo were not kept`);
    return {
        mirror,
        listeners: {
            presentationDigest: (digest) => void mirror.announced(digest).catch(kept(`announce`)),
            adopted: (sent) => void mirror.adopted(sent).catch(kept(`adoption`)),
        },
    };
};
