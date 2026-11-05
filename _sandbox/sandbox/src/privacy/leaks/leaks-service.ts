import { errorMessage } from "@intentic/base/errors";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import {
    leakSource,
    leakWordKey,
    PRIVACY_SCAN_CONVERSATIONS_DEFAULT,
    type PrivacyHardening,
    type PrivacyHardeningMeasure,
    type PrivacyLeak,
    type PrivacyLeakReport,
    type PrivacyLeaks,
    type PrivacyLeakView,
} from "@intentic/sandbox-contract/schemas/privacy-leaks";
import type { Lexicon } from "@intentic/privacy-detect/lexicon";
import { opt } from "../../opt.js";
import type { EntityRecognizer, Masker } from "../masker.js";
import { detectorFor } from "../policy-detector.js";
import type { PrivacyShield } from "../privacy-shield.js";
import { caughtBy, hardeningProblems, leakWordReader, measureHardening, withHardening } from "./hardening.js";
import { contextAround, labelBefore, outlineOf, valueAt, wordFactsOf } from "./leak-outline.js";
import { fieldSuspects, leaksIn, modelSuspects, type Suspect, transcriptText } from "./leak-scan.js";
import type { PrivacyLeakStore } from "./leak-store.js";

// The leaks and the hardening of the shield against them, as the privacy routes serve them (schemas/privacy-leaks.ts).
// Everything runs on this machine: a scan reads conversations here, a measure runs the detectors here, and what a reader
// is shown of a leak depends on whether that reader may read values (`reveal`).

export interface LeaksDeps {
    readonly shield: Pick<PrivacyShield, "policy" | "setPolicy" | "masker" | "learn" | "forget" | "recognizer">;
    readonly store: PrivacyLeakStore;
    // The most recent conversations first, each with what its transcript holds.
    readonly conversations: () => readonly { readonly id: string; readonly updatedAt: number }[];
    readonly rows: (conversationId: string) => Promise<readonly TranscriptRow[]>;
    readonly now?: () => Date;
}

export class LeakRefusal extends Error {}

// One vault source per leak (schemas/privacy-leaks.ts `leakSource`), so dismissing one forgets that value alone.
export { leakSource };

// How much of each conversation a scan reads, and how much the name model reads in all: it takes seconds per few
// thousand characters on a CPU.
const SCAN_CHARS_PER_CONVERSATION = 200_000;
const MODEL_CHARS_PER_SCAN = 60_000;
// The control text a measure reads: the newest conversations, up to this much in all.
const CONTROL_CONVERSATIONS = 10;
const CONTROL_CHARS = 400_000;
const SUSPECTS_PER_SCAN = 100;

const keyOf = (leak: Pick<PrivacyLeak, "class" | "value">): string => `${leak.class}\u0000${leak.value.toLowerCase()}`;

// The model a measure and a leak's verdict read with: the one the policy asks for, when installed.
const modelFor = async (shield: LeaksDeps["shield"], policy: PrivacyShieldPolicy): Promise<EntityRecognizer | undefined> =>
    policy.names === "model" ? shield.recognizer() : undefined;

const viewOf = async (
    leak: PrivacyLeak,
    policy: PrivacyShieldPolicy,
    lexicon: Lexicon,
    recognizer: EntityRecognizer | undefined,
    reveal: boolean,
): Promise<PrivacyLeakView> => {
    const at = valueAt(leak.context, leak.value);
    const label = at === undefined ? undefined : labelBefore(leak.context, at, lexicon);
    return {
        id: leak.id,
        at: leak.at,
        class: leak.class,
        origin: leak.origin,
        state: leak.state,
        ...opt("why", leak.why),
        ...opt("conversationId", leak.conversationId),
        outline: outlineOf(leak.value),
        length: leak.value.length,
        ...opt("label", label),
        words: wordFactsOf(leak.value, lexicon),
        caught: await caughtBy(policy, leak, recognizer),
        ...opt("value", reveal ? leak.value : undefined),
        ...opt("context", reveal && leak.context !== "" ? leak.context : undefined),
    };
};

const textOf = async (deps: LeaksDeps, conversationId: string, max: number): Promise<string> =>
    transcriptText(await deps.rows(conversationId).catch((): TranscriptRow[] => []), max);

const recent = (deps: LeaksDeps, count: number) => deps.conversations().toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, count);

// The control text a measure reads: what the newest conversations here hold, up to CONTROL_CHARS in all.
const controlTexts = async (deps: LeaksDeps): Promise<string[]> => {
    const texts: string[] = [];
    let left = CONTROL_CHARS;
    for (const conversation of recent(deps, CONTROL_CONVERSATIONS)) {
        if (left <= 0) {
            break;
        }
        const text = await textOf(deps, conversation.id, left);
        left -= text.length;
        texts.push(text);
    }
    return texts.filter((text) => text !== "");
};

const teach = async (deps: LeaksDeps, leak: PrivacyLeak): Promise<void> => {
    await deps.shield.learn(leakSource(leak.id), [{ value: leak.value, class: leak.class }]);
};

const nowOf = (deps: LeaksDeps): string => (deps.now ?? (() => new Date()))().toISOString();

// Every leak and proposal as a reader is shown them; the proposals' leak words resolved only for one who may read them.
export const leaksView = async (deps: LeaksDeps, reveal: boolean): Promise<PrivacyLeaks> => {
    const [stored, policy] = await Promise.all([deps.store.read(), deps.shield.policy()]);
    const lexicon = detectorFor(policy).lexicon;
    const recognizer = await modelFor(deps.shield, policy);
    const leaks: PrivacyLeakView[] = [];
    for (const leak of stored.leaks.toReversed()) {
        leaks.push(await viewOf(leak, policy, lexicon, recognizer, reveal));
    }
    const read = leakWordReader(stored.leaks);
    const words: Record<string, string> = {};
    for (const word of reveal ? stored.proposals.flatMap((proposal) => proposal.hardening.lists.flatMap((list) => list.fromLeaks)) : []) {
        const value = read(word);
        if (value !== undefined) {
            words[leakWordKey(word)] = value;
        }
    }
    return { leaks, proposals: stored.proposals.toReversed(), words, revealed: reveal, ...opt("session", stored.session) };
};

// Kept confirmed, its exact value taught at once: the reporter's word that it is personal data. A value already kept
// under that kind is confirmed rather than kept twice.
export const reportLeak = async (deps: LeaksDeps, report: PrivacyLeakReport): Promise<PrivacyLeak> => {
    const at = report.context === undefined ? undefined : valueAt(report.context, report.value);
    const context = report.context === undefined || at === undefined ? "" : contextAround(report.context, at, report.value.length);
    const existing = (await deps.store.read()).leaks.find((leak) => keyOf(leak) === keyOf(report));
    const [leak] =
        existing === undefined
            ? await deps.store.add([
                  {
                      at: nowOf(deps),
                      class: report.class,
                      value: report.value,
                      context,
                      ...opt("conversationId", report.conversationId),
                      origin: "reported",
                      state: "confirmed",
                  },
              ])
            : [existing.state === "confirmed" ? existing : ((await deps.store.judge(existing.id, "confirmed")) ?? existing)];
    if (leak === undefined) {
        throw new LeakRefusal("The leak could not be kept.");
    }
    await teach(deps, leak);
    return leak;
};

// Confirmed: taught. Dismissed: no personal data, and a value taught for it forgotten.
export const judgeLeak = async (deps: LeaksDeps, id: string, state: "confirmed" | "dismissed"): Promise<void> => {
    const leak = await deps.store.judge(id, state);
    if (leak === undefined) {
        throw new LeakRefusal(`There is no leak ${id}.`);
    }
    if (state === "confirmed") {
        await teach(deps, leak);
    } else {
        await deps.shield.forget(leakSource(id));
    }
};

// The suspects one conversation's text holds that nothing masks, as leaks to keep.
const suspectsOf = async (
    text: string,
    masker: Masker,
    recognizer: EntityRecognizer | undefined,
): Promise<Suspect[]> => {
    const suspects: Suspect[] = fieldSuspects(text);
    if (recognizer !== undefined && text !== "") {
        suspects.push(...(await modelSuspects(text, recognizer)));
    }
    return leaksIn(suspects, await masker.inspect(text));
};

// The newest conversations read for leaks on this machine; each new suspect kept for the owner to judge.
export const scanLeaks = async (deps: LeaksDeps, count = PRIVACY_SCAN_CONVERSATIONS_DEFAULT): Promise<{ conversations: number; chars: number; suspected: number }> => {
    // The shield as it masks today, the vault included; the model is asked separately, as a finder of suspects.
    const masker = await deps.shield.masker({ ...(await deps.shield.policy()), names: "dictionary" });
    const recognizer = await deps.shield.recognizer();
    const known = new Set((await deps.store.read()).leaks.map(keyOf));
    const conversations = recent(deps, count);
    const found: Omit<PrivacyLeak, "id">[] = [];
    let chars = 0;
    for (const conversation of conversations) {
        const text = await textOf(deps, conversation.id, SCAN_CHARS_PER_CONVERSATION);
        // The model reads only the first stretch of the scan: it takes seconds per few thousand characters on a CPU.
        const model = chars < MODEL_CHARS_PER_SCAN ? recognizer : undefined;
        chars += text.length;
        for (const suspect of await suspectsOf(text, masker, model)) {
            if (known.has(keyOf(suspect)) || found.length >= SUSPECTS_PER_SCAN) {
                continue;
            }
            known.add(keyOf(suspect));
            const context = contextAround(text, suspect.start, suspect.value.length);
            found.push({ at: nowOf(deps), class: suspect.class, value: suspect.value, context, conversationId: conversation.id, origin: "scan", state: "suspected", why: suspect.why });
        }
    }
    await deps.store.add(found);
    return { conversations: conversations.length, chars, suspected: found.length };
};

// Additions measured on this machine against the leaks and the newest conversations.
export const measureLeakHardening = async (deps: LeaksDeps, hardening: PrivacyHardening, reveal: boolean): Promise<PrivacyHardeningMeasure> => {
    const policy = await deps.shield.policy();
    return measureHardening({
        policy,
        hardening,
        leaks: (await deps.store.read()).leaks,
        control: await controlTexts(deps),
        reveal,
        recognizer: await modelFor(deps.shield, policy),
    });
};

// Kept for the owner once it could be saved as written; measured with outlines only, since every session reads it back.
export const proposeHardening = async (
    deps: LeaksDeps,
    input: { readonly title: string; readonly why: string; readonly hardening: PrivacyHardening },
    conversationId: string | undefined,
): Promise<{ id: string; measured: PrivacyHardeningMeasure }> => {
    const problems = hardeningProblems(input.hardening);
    if (problems.length > 0) {
        throw new LeakRefusal(problems.join(" "));
    }
    try {
        withHardening(await deps.shield.policy(), input.hardening, leakWordReader((await deps.store.read()).leaks), "check");
    } catch (error) {
        throw new LeakRefusal(errorMessage(error));
    }
    const measured = await measureLeakHardening(deps, input.hardening, false);
    const proposal = await deps.store.propose({
        at: nowOf(deps),
        ...opt("conversationId", conversationId),
        title: input.title,
        why: input.why,
        hardening: input.hardening,
        measured,
    });
    return { id: proposal.id, measured };
};

// The proposal written into the policy as saved, then taken off the list. `save` is the owner's own write, which refuses
// a pattern it cannot run or a change the organisation pinned, and leaves the proposal standing when it does.
export const applyProposal = async (deps: LeaksDeps, id: string, save: (policy: PrivacyShieldPolicy) => Promise<void>): Promise<void> => {
    const stored = await deps.store.read();
    const proposal = stored.proposals.find((each) => each.id === id);
    if (proposal === undefined) {
        throw new LeakRefusal(`There is no proposal ${id}.`);
    }
    let next: PrivacyShieldPolicy;
    try {
        next = withHardening(await deps.shield.policy(), proposal.hardening, leakWordReader(stored.leaks), id.toLowerCase());
    } catch (error) {
        throw new LeakRefusal(errorMessage(error));
    }
    await save(next);
    await deps.store.takeProposal(id);
};

export const dismissProposal = async (deps: LeaksDeps, id: string): Promise<void> => {
    if ((await deps.store.takeProposal(id)) === undefined) {
        throw new LeakRefusal(`There is no proposal ${id}.`);
    }
};
