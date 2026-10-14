import type { ChatEvent, ChatModel } from "./types";

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * A model for running the app without an API key. It answers with the first sentence of each of the first two
 * sources, each cited with a quote, so the whole path (streaming, citations, the page links) works offline. It
 * reads the sources from the prompt the way the real model would. With no sources it abstains.
 */
export function echoModel({ delayMs = 25 }: { delayMs?: number } = {}): ChatModel {
  return {
    id: "fake:echo",
    async *stream(request): AsyncGenerator<ChatEvent> {
      const last = request.messages.at(-1);
      const prompt = last?.role === "user" ? last.content : "";
      const sources = [...prompt.matchAll(/<source id="(S\d+)" title="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/source>/g)];
      const lines = sources.slice(0, 2).map(([, label, title, text]) => {
        const sentence = firstSentence(text);
        return `- **${title}**: ${sentence} [[${label}: "${quoteOf(sentence)}"]]`;
      });
      const answer = lines.length
        ? `*(Offline answer: no OPENAI_API_KEY is set, so this repeats the top sources.)*\n\n${lines.join("\n")}`
        : "I couldn't find an answer to that in the documents you can access.";
      for (const piece of answer.match(/\S+\s*/g) ?? []) {
        await delay(delayMs, request.abortSignal);
        yield { type: "text-delta", delta: piece };
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: undefined, outputTokens: undefined, reasoningTokens: undefined },
      };
    },
  };
}

function firstSentence(text: string): string {
  const plain = text
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line && !line.startsWith("|"))
    .join(" ");
  const match = /^.{20,240}?[.!?](?=\s|$)/.exec(plain);
  return (match?.[0] ?? plain.slice(0, 200)).trim();
}

/** Up to twelve words of the sentence, without double quotes, which would end the citation early. */
function quoteOf(sentence: string): string {
  return sentence
    .replace(/["“”*_`]/g, "")
    .split(/\s+/)
    .slice(0, 12)
    .join(" ")
    .replace(/[.!?]$/, "");
}
