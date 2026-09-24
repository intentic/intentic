import { serveWorkerCall } from "../../../../lib/workerCall";
import { tableDiff } from "./tableDiff";
import type { TableDiffArgs } from "./tableDiffClient";

serveWorkerCall(({ before, after }: TableDiffArgs) => tableDiff(before, after));
