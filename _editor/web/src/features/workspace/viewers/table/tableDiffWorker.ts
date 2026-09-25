import { serveWorkerCall } from "@intentic/ui/worker-call";
import { tableDiff } from "./tableDiff";
import type { TableDiffArgs } from "./tableDiffClient";

serveWorkerCall(({ before, after }: TableDiffArgs) => tableDiff(before, after));
