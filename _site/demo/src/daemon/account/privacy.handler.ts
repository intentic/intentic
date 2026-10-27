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
} satisfies Doors<`privacy`>;
