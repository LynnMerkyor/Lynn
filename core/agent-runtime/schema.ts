import { Type, type TSchema } from "@sinclair/typebox";

export function StringEnum<T extends readonly string[]>(values: T, ..._options: unknown[]): TSchema {
  if (!values.length) return Type.String();
  return Type.Union(values.map((value) => Type.Literal(value)));
}

export { Type };
