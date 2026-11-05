import { capabilitiesOf, loopsOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { PROVIDER_SPECS } from "@intentic/sandbox-contract/models/provider-specs";
import { refuse } from "@intentic/contract-serve";
import { demoNameDictionary } from "../../fixture/nameDictionary";
import { previewText } from "../../fixture/data-protection/preview";
import { setShieldPolicy, shieldPolicy } from "../../fixture/data-protection/shield";
import { type Doors, okAfter } from "../doors";

// A fresh sandbox's shield: off until the visitor turns it on, nothing learned, no reader installed, and this catalog's
// providers to trust. The policy saves (fixture/data-protection/shield.ts, which the preset writes too), and the "try it"
// box marks what the policy's detectors would mask. Nothing is logged: the recording sends no model traffic through it.
export const privacyDoors = {
    status: () => ({
        policy: shieldPolicy(),
        known: 0,
        tokens: 0,
        readers: { ocr: false, model: false },
        providers: PROVIDER_SPECS.map((spec) => ({
            id: spec.id,
            label: spec.label,
            shieldable: loopsOf(spec.id).some((loop) => capabilitiesOf(spec.id, loop).privacy === `gateway`),
            local: false,
        })),
    }),
    setPolicy: (policy) => okAfter(() => setShieldPolicy(policy)),
    log: () => [],
    // Nothing is logged, so there is no token to read back.
    reveal: () => ({}),
    image: () => refuse(`This is the demo workspace: its privacy shield has painted over no image.`),
    dictionary: ({ query }) => demoNameDictionary(query),
    preview: ({ text }) => previewText(text, shieldPolicy()),
    sources: () => [],
    // Nothing has been taught, so there is nothing to forget.
    forget: () => ({ forgotten: 0 }),
    // No model traffic went through the shield here, so nothing leaked, a scan finds nothing, and no session proposed anything.
    leaks: () => ({ leaks: [], proposals: [], words: {}, revealed: true }),
    report: () => refuse(`This is the demo workspace: nothing it shows reached a model provider, so there is no leak to report.`),
    judge: () => refuse(`This is the demo workspace: it has no leak to judge.`),
    scan: () => ({ conversations: 0, chars: 0, suspected: 0 }),
    applyProposal: () => refuse(`This is the demo workspace: no session has proposed anything to apply.`),
    dismissProposal: () => refuse(`This is the demo workspace: no session has proposed anything to dismiss.`),
    hardeningSession: () => okAfter(() => undefined),
} satisfies Doors<`privacy`>;
