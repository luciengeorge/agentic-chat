// 👨‍💼 Ana, a new engineer at Kestrel, clones the repo on her first day. She has no OpenAI key yet, but she
//    still wants to ask the assistant a question and watch it answer, citations and all. The app talks to
//    models through one interface, so a model that just echoes the sources back can stand in for gpt-6-luna.

import type { ChatEvent, ChatModel } from "#learn/model/types";

/** Waits `ms`, or rejects with the signal's reason, at once if it has already aborted. */
export const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
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
      // 🐨 Work out what to say: the last message is the user's prompt, sources and question together.
      //    echoAnswer(prompt) turns it into the answer text.
      // 🐨 Stream it: one text-delta event per word (with the space after it), waiting delayMs before each.
      //    Pass request.abortSignal to that wait, so a caller who stops listening stops the model too.
      // 🐨 Then end with exactly one finish event: finishReason "stop", and a usage whose three counts are
      //    undefined. On every path that ends normally, the finish comes last, after the final delta.
      //
      // 💰 `text.match(/\S+\s*/g)` splits text into words, each with the whitespace after it.
      //    `await delay(ms, signal)` waits, or throws the signal's reason once it has aborted.
      //    `yield { type: "text-delta", delta }` sends one event.
      //
      // 🦉 Why an interface at all. Nothing in the app imports OpenAI. The chat route, the answer pipeline and
      //    the agent loop take a `ChatModel` and call `stream(request)`. So any object with that one method
      //    can stand in: the hand-written client you build next, the AI SDK, a test's scripted fake, or this
      //    model, which runs the whole app on a laptop with no API key. The interface is also a promise
      //    about order: text deltas, then one finish. Every caller relies on it, so every model must keep it.
      // 🦉 Why the finish carries usage, and why undefined here. Usage is what the provider says it billed:
      //    tokens in, tokens out, and the reasoning tokens inside "out". Budgets and the cost log add it up.
      //    Nobody billed this call, so nobody counted anything: undefined says "no count came back". A 0
      //    would say "counted, and it was free", and a budget would believe it.
      // 🦉 Why an abort throws instead of just stopping. A generator that returns early looks like an answer
      //    that ended normally, except the finish never comes. The caller would save half an answer as if
      //    it were whole. Throwing the signal's reason tells it the stream was stopped, and by whom.
      //
      // 📜 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function*
      // 📜 https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
      //
      // 🚨 The tests check that the answer arrives word by word with one finish at the end, that an abort
      //    stops the stream with the signal's reason and no finish, that usage is undefined (not 0), that the
      //    app's answer() streams it with valid citations, and that it streams the same shape as the
      //    recorded gpt-6-luna call: deltas, then one finish.
      throw new Error(
        `echoModel({ delayMs: ${delayMs} }).stream (${request.messages.length} messages) isn't written yet`,
      );
    },
  };
}

/** What the echo model says to a prompt: the first sentence of the first two sources, cited, or the abstention. */
export function echoAnswer(prompt: string): string {
  const sources = [...prompt.matchAll(/<source id="(S\d+)" title="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/source>/g)];
  const lines = sources.slice(0, 2).map(([, label, title, text]) => {
    const sentence = firstSentence(text);
    return `- **${title}**: ${sentence} [[${label}: "${quoteOf(sentence)}"]]`;
  });
  return lines.length
    ? `*(Offline answer: no OPENAI_API_KEY is set, so this repeats the top sources.)*\n\n${lines.join("\n")}`
    : "I couldn't find an answer to that in the documents you can access.";
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
