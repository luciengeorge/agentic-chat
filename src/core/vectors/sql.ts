const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** A table, column or index name, checked so it can go into SQL as is. */
export function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new RangeError(`not an identifier: ${JSON.stringify(name)}`);
  return name;
}

/** The text form pgvector parses: `[0.1,0.2,...]`. */
export const vectorLiteral = (vector: readonly number[]) => JSON.stringify(vector);
