import type { IntenticApi } from "@intentic/extension-api";

// The Runners section's shapes, read off the typed client rather than imported: the contract's schemas/ci-fleet.ts and
// schemas/devices.ts are not on the extension wire (EXTENSION_WIRE in _shared/extension-api/src/wire.ts), while the
// procedures that answer with them are, so the client's own answer types are the versioned ones.
type System = IntenticApi[`sandbox`][`rpc`][`system`];
type Answer<P extends keyof System> = System[P] extends (...args: never[]) => PromiseLike<infer A> ? A : never;
type Asked<P extends keyof System> = System[P] extends (input: infer I, ...rest: never[]) => PromiseLike<object> ? I : never;

export type CiFleet = Answer<`deviceCiFleet`>;
export type CiRunner = CiFleet[`runners`][number];
export type CiFleetService = CiFleet[`service`];
export type CiSlots = NonNullable<CiFleet[`slots`]>;
export type CiFleetPass = NonNullable<CiFleet[`janitor`]>;
export type CiRunnerOp = Asked<`deviceCiRunnerOp`>[`op`];
export type Device = Answer<`devices`>[`devices`][number];
