import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the drift a phone door can hold, a live socket or a paired app the owner's cards no longer list, is between this subsystem and the capability manifest, so it is checked where the rosters meet (peers/invariant.ts, live-phones-are-enrolled and enrolled-phones-have-cards). The one record kept here, each phone's wake channel, is keyed by the card and moved or dropped with it by the phone capability handler (rekey, forget); a channel the relay calls dead is forgotten on the send that hears so. */

export const owner = "phones";

export const checks = (): readonly InvariantCheck[] => [];
