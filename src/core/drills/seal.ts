/**
 * Section 20's drills keep their answers sealed: what a fault changes, where, and why. A sealed value is JSON,
 * deflated, then XORed with a keystream from SHA-256 over a fixed salt and the value's name, then base64. The key
 * is right here, so this hides an answer from `git diff`, grep and a glance at the code, not from someone who
 * decodes it on purpose. On a machine the learner owns, nothing stronger is possible: `ex` has to read it too.
 */
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const SALT = "agentic-chat drills: a spoiler, not a secret";

function xor(bytes: Buffer, name: string): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let block = 0; block * 32 < bytes.length; block++) {
    const key = createHash("sha256").update(`${SALT}:${name}:${block}`).digest();
    for (let i = 0; i < 32 && block * 32 + i < bytes.length; i++) {
      out[block * 32 + i] = bytes[block * 32 + i] ^ key[i];
    }
  }
  return out;
}

export function seal(name: string, value: unknown): string {
  return xor(deflateRawSync(Buffer.from(JSON.stringify(value), "utf8")), name).toString("base64");
}

export function unseal<T>(name: string, text: string): T {
  return JSON.parse(inflateRawSync(xor(Buffer.from(text, "base64"), name)).toString("utf8")) as T;
}
