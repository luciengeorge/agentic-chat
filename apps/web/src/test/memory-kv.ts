import type { KeyValue } from "@/lib/session-store";

export function memoryKv(): KeyValue & { entries: Map<string, { value: string; ex: number }> } {
  const entries = new Map<string, { value: string; ex: number }>();
  return {
    entries,
    get: async (key) => entries.get(key)?.value ?? null,
    set: async (key, value, { EX }) => entries.set(key, { value, ex: EX }),
    getDel: async (key) => {
      const value = entries.get(key)?.value ?? null;
      entries.delete(key);
      return value;
    },
    del: async (key) => entries.delete(key),
  };
}
