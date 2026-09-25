import type { z } from "zod";
import type {
    AtConversion,
    DropConversion,
    FoldConversion,
    MapValueConversion,
    PinDefaultConversion,
    RenameConversion,
    RetireEntriesConversion,
    RetypeConversion,
    TransformConversion,
} from "./conversions.js";
import type { DocumentSpec } from "./documents.js";

// The conversions of conversions.ts replayed on types: given a shape an earlier build wrote (frozen by the shape
// generator, scripts/write-state-shapes.ts) and a document's history, the shape its conversions leave. The generated
// checks (store/shapes/state-shapes.gen.ts) require that shape to be assignable to what today's schema accepts, so a
// schema change that would strand an old file fails the typecheck at the document until a conversion covers it.
// The declarative conversions are modelled exactly; `transform` by its declared input and output.

// Keys renamed as the value moves: optionality follows the key, since a homomorphic mapped type keeps modifiers.
type Renamed<S, From extends string, To extends string> = From extends keyof S
    ? { [K in keyof S as K extends From ? To : K extends To ? never : K]: S[K] }
    : S;

type ReplaceIn<V, In, Out> = V extends In ? Out : V;

type MapIn<V, Mapping> = V extends keyof Mapping ? Mapping[V] : V;

type Pinned<S, Key extends string, Value> = Key extends keyof S
    ? { [K in keyof S as K extends Key ? never : K]: S[K] } & { [K in Key]: Exclude<S[K & keyof S], undefined> | Value }
    : S & { [K in Key]: Value };

type Field<S, Key extends string, Replace> = Key extends keyof S ? { [K in keyof S]: K extends Key ? Replace : S[K] } : S;

// One conversion over one shape. Retiring removes entries: an entry shape loses the retired arms of its union, a list
// shape the retired arms of its element. Every other conversion rewrites an object's fields; an array or a primitive is
// never an object a field conversion touches.
export type ApplyConversion<S, C> =
    C extends RetireEntriesConversion<infer Gone> ? (S extends ReadonlyArray<infer E> ? Exclude<E, Gone>[] : Exclude<S, Gone>) : ApplyToFields<S, C>;

type ApplyToFields<S, C> = S extends readonly unknown[]
    ? S
    : S extends object
      ? C extends RenameConversion<infer From, infer To>
          ? Renamed<S, From, To>
          : C extends DropConversion<infer Key>
            ? Omit<S, Key>
            : C extends RetypeConversion<infer Key, infer In, infer Out>
              ? Field<S, Key, ReplaceIn<S[Key & keyof S], In, Out>>
              : C extends MapValueConversion<infer Key, infer Mapping>
                ? Field<S, Key, MapIn<S[Key & keyof S], Mapping>>
                : C extends PinDefaultConversion<infer Key, infer Value>
                  ? Pinned<S, Key, Value>
                  : C extends TransformConversion<infer In, infer Out>
                    ? S extends In
                        ? Out
                        : S
                    : C extends FoldConversion<infer From, infer Into, infer Out>
                      ? Omit<S, From | Into> & { [K in Into]: Out }
                      : C extends AtConversion<infer Path, infer Inner>
                        ? ApplyAt<S, Path, Inner>
                        : S
      : S;

type ApplyToEach<S, C> =
    S extends ReadonlyArray<infer E> ? ApplyConversion<E, C>[] : S extends Readonly<Record<string, infer V>> ? Record<string, ApplyConversion<V, C>> : S;

type AtEach<S, Rest extends string, C> =
    S extends ReadonlyArray<infer E> ? ApplyAt<E, Rest, C>[] : S extends Readonly<Record<string, infer V>> ? Record<string, ApplyAt<V, Rest, C>> : S;

// A dotted path into the shape, `*` meaning every element or value, as the runtime `at` walks it.
export type ApplyAt<S, Path extends string, C> = Path extends `${infer Head}.${infer Rest}`
    ? Head extends "*"
        ? AtEach<S, Rest, C>
        : Field<S, Head, ApplyAt<S[Head & keyof S], Rest, C>>
    : Path extends "*"
      ? ApplyToEach<S, C>
      : Field<S, Path, ApplyConversion<S[Path & keyof S], C>>;

// A whole history, left to right.
export type ApplyChain<S, History> = History extends readonly [infer Head, ...infer Rest] ? ApplyChain<ApplyConversion<S, Head>, Rest> : S;

// What a frozen shape becomes under a document's history.
export type Converted<S, D extends DocumentSpec> = ApplyChain<S, D["history"]>;

// Holds when `Actual` fits `Target`; a violation names the incompatible property in the compiler's own words, which is
// the whole point of spelling the check as a constraint rather than a conditional that answers `false`.
export type Fits<Target, Actual extends Target> = Actual;

// What today's schema accepts for one document (one entry of it for an entry list or a keyed record).
export type Accepted<D extends DocumentSpec> = z.input<D["schema"]>;

// Keys a history retires: a rename's old name, a dropped key. None may name a key today's schema declares, or every read
// would remove it (the second of the two rules conversions.ts states).
type RetiredBy<C> = C extends RenameConversion<infer From, string> ? From : C extends DropConversion<infer Key> ? Key : never;
export type Retired<History> = History extends readonly (infer C)[] ? RetiredBy<C> : never;

// The overlap, which the generated checks require to be `never`.
export type ReusedKeys<D extends DocumentSpec> = Extract<Retired<D["history"]>, keyof Accepted<D>>;
