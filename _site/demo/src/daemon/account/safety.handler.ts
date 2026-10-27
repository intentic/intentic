import { readPolicy, safetyLog, writePolicy } from "./preferences";
import { type Doors, okAfter } from "../doors";

// The policy is long enough to overflow its section, because that is the only state the policy's surface has a decision
// to make in. A save replaces it whole and sticks until a reload (preferences.ts).
export const safetyDoors = {
    policy: readPolicy,
    setPolicy: ({ text }) => okAfter(() => writePolicy(text)),
    log: safetyLog,
} satisfies Doors<`safety`>;
