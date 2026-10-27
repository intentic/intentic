import type { GroupSamples } from "./context.ts";
import { SECRET_SAMPLES } from "../smoke-secrets.ts";

// The generated name is one nothing holds, so the Generate answers its length rather than the refusal.
export const secretsSamples: GroupSamples<`secrets`> = () => ({
    ...SECRET_SAMPLES,
    list: undefined,
    generate: { key: `SMOKE_GENERATED`, bytes: 32, format: `hex` },
    passwords: undefined,
    passwordNeeds: undefined,
    passwordActivity: undefined,
});
