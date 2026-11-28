import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { SliceFakeContext } from "../harness/slice-fake.testing.js";
import { fileContactsStore, s2sContactsDocument } from "./contacts/contacts-store.js";
import { fileThreadsStore } from "./messages/threads-store.js";
import type { S2s } from "./s2s-service.js";
import type { S2sSlice } from "./s2s-slice.js";

// The sandbox-to-sandbox slice as route suites stand it up (harness/route-services.testing.ts): the contacts and the
// threads, real, on the suite's own history volume (none of the first, so a send goes the old way; the second where the
// account door files a drop). What crosses to another sandbox (the outbox, admission, the inbox door) is unstubbed: a
// suite about that stands two daemons up (s2s.testing.ts). Not part of the build.

export const s2sSliceFake = (context: Pick<SliceFakeContext, "historyRoot">) =>
    ({
        s2s: unstubbed<S2s>("s2s", {
            contacts: fileContactsStore(join(context.historyRoot, s2sContactsDocument.path)),
            threads: fileThreadsStore(context.historyRoot),
        }),
    }) satisfies Partial<S2sSlice>;
