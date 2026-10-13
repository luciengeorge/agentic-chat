import { countTokens as count } from "gpt-tokenizer/encoding/o200k_base";

const NO_SPECIAL = { disallowedSpecial: new Set<string>() };

/** Tokens in `text` under o200k_base, the encoding of OpenAI's current models. Special tokens count as plain text. */
export function countTokens(text: string): number {
  return count(text, NO_SPECIAL);
}
