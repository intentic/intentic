import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { WallAnswers } from "./conversation-next.js";
import type { Postures } from "../registry/agents-store.js";

// The answers a card's `next` is derived by (conversation-next.ts): each conversation's own, else the sandbox's, which
// the card must follow the moment Settings changes them, as the resume pass does (resume-nudges.ts). Read here once and
// again on every write, since a card is projected synchronously and the settings store answers only asynchronously.

type Defaults = Pick<SandboxSettings, "limitPolicy" | "memoryPolicy">;

/** The sandbox's settings as the registry follows them: a read that answers undefined when it failed, and every write. */
export interface WallAnswersSource {
    readonly get: () => Promise<Defaults | undefined>;
    readonly onSet: (listener: () => void) => () => void;
}

export interface WallAnswersFollower {
    // This conversation's answers: its own, else the sandbox's as last read.
    readonly of: (postures: Postures) => WallAnswers;
    // Reads the sandbox's now, and again on every write, calling `changed` once a write's answers are in.
    readonly follow: (changed: () => void) => Promise<void>;
}

const answersIn = (settings: Defaults): WallAnswers => ({ limit: settings.limitPolicy, memory: settings.memoryPolicy });

// Without a source (a fixture), the schema's own defaults answer, as an unwritten settings file does.
export const wallAnswersFollower = (source: WallAnswersSource | undefined): WallAnswersFollower => {
    let sandbox = answersIn(SandboxSettingsSchema.parse({}));
    const read = async (): Promise<void> => {
        const settings = await source?.get();
        sandbox = settings === undefined ? sandbox : answersIn(settings);
    };
    return {
        of: (postures) => ({ limit: postures.limit ?? sandbox.limit, memory: postures.memory ?? sandbox.memory }),
        follow: async (changed) => {
            await read();
            source?.onSet(() => void read().then(changed));
        },
    };
};
