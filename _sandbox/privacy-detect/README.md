# privacy-detect

Finds personal data in any text on this machine, with no model and no network: the privacy shield's detectors, from PESEL and card numbers to Polish and English names.

- One synchronous pass per kind over tool output, database dumps, CSV, JSON, prose, code and mail, so the shield's
  gateway can mask a request without waiting on anything. Every value it masks is put back in the answer, so a false
  find costs the model a little understanding while a missed one leaks: the rules lean to finding, except in code,
  where identifiers must stay readable.
- Identifiers are held to their own algorithms (PESEL, NIP, Polish ID cards and passports, IBAN and NRB accounts, Luhn with an
  issuer's prefix), so a run of digits is a find only when its checksum says so.
- A name is masked only as a name: a first name with a surname that is no ordinary word, or what a title, a field for
  a part of a name or a personal mail address vouches for. The lists under `src/data/` are generated from public name
  and word corpora by the `generate*.mjs` scripts beside them, run by hand.
- The owner adjusts the lists in the privacy shield's policy: any list in `name-lists.ts` can be switched off, and
  lists of their own (first names, surnames, ordinary words, titles, never-names) are read beside the rest.
  `createLexicon` builds the lexicon for one such configuration, and `detectPersonalData` takes it as `lexicon`;
  without one, every built-in list is read.
- One gate for every source (`createGate` in `detect.ts`): the detectors, the owner's rules, the values the daemon's
  vault already holds and its local name model each propose candidates, and the gate keeps one only when its kind is
  looked for, it is not a value the owner never masks, and its evidence holds where it stands. A detector's find and the
  owner's own word bring their evidence; a learned value or a model's guess is held to `standsAlone` (`standalone.ts`),
  the detectors' own checks for that kind, so a misread fixed in a detector cannot come back through the vault.
- Private: the daemon depends on it for the shield (`privacy/` in [`@intentic/sandbox`](../sandbox)). Subpath exports
  keep each reader to what it needs: `.` is the detector and its gate, `./text` the character tests the vault's matcher
  shares, `./data/*` the lists, `./name-lists` the registry of them the privacy page describes, `./lexicon` a word's
  reading, and `./testing` builds valid identifiers for the daemon's suites.

(2026-10-16: this was `src/privacy/detect/` inside the daemon until it became its own package. It imported nothing of
the daemon but one type from the contract.)

## Key files

- [src/detect.ts](src/detect.ts) — `detectPersonalData`, and `createGate`: the one gate every source's candidates pass.
- [src/names.ts](src/names.ts) — first name and surname, titles and name fields, in Polish and English.
- [src/checksums.ts](src/checksums.ts) — the identifiers' own validity checks.
- [src/standalone.ts](src/standalone.ts) — what a value proposed without its context (the vault's, the model's) must still be where it stands.
- [src/tests/corpus.test.ts](src/tests/corpus.test.ts) — the labelled corpus: what must and must not be masked, in every language the product ships.
- [src/lexicon.ts](src/lexicon.ts) — what the lists say a word is: a name, an ordinary word, a title; `createLexicon` for the owner's configuration.
- [src/name-lists.ts](src/name-lists.ts) — every list the owner can switch off, its source and where its words go.
- [src/tests/ids.testing.ts](src/tests/ids.testing.ts) — valid identifiers computed from their parts, for tests.

## Commands

```sh
pnpm --filter @intentic/privacy-detect test
```
