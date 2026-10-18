import type { ChatEvent, ChatMessage, ToolSpec } from "#learn/model/types";

import { parseSse, responsesChatModel } from "#learn/model/responses";
import { countRequestTokens, countTokens, type RequestTokens } from "#learn/model/tokens";
import { type CassetteName, cassette, cassetteFetch, chunkedBody } from "@/core/model/cassette";

export interface LabSseEvent {
  index: number;
  event: string | null;
  /** The data's `type`, when it's JSON with one. */
  type: string | null;
  /** The data, pretty-printed when it's JSON. */
  data: string;
}

export interface LabChatEvent {
  type: ChatEvent["type"];
  /** A text delta's text. */
  delta: string | null;
  json: string;
}

export interface Inspection {
  name: CassetteName;
  title: string;
  /** The request body as it was sent, pretty-printed. */
  request: string;
  contentType: string;
  bytes: number;
  reads: number;
  /** The reply as `#learn/model/responses`' parseSse reads it; null for a JSON reply. */
  events: LabSseEvent[] | null;
  /** What `responsesChatModel` yields from the reply, each as JSON; null for a JSON reply. */
  chatEvents: LabChatEvent[] | null;
  /** A JSON reply, pretty-printed. */
  response: string | null;
  /** An error your code threw, and where. */
  error: string | null;
  counted: (RequestTokens & { schema: number }) | null;
  billed: { input: number; output: number; reasoning: number } | null;
}

type InputItem =
  | { role: string; content: string | Array<{ type: string; text?: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface RecordedBody {
  instructions?: string;
  input: InputItem[];
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  text?: { format?: { schema?: unknown } };
}

const text = (content: string | Array<{ type: string; text?: string }>) =>
  typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** The recorded body's input as our messages, so `countRequestTokens` can count it. A developer item is the
 * instructions (the AI SDK sends them that way). */
function messagesOf(body: RecordedBody): { instructions: string; messages: ChatMessage[] } {
  let instructions = body.instructions ?? "";
  const messages: ChatMessage[] = [];
  const names = new Map<string, string>();
  for (const item of body.input) {
    if ("role" in item) {
      if (item.role === "developer" || item.role === "system") instructions = text(item.content);
      else messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: text(item.content) });
    } else if (item.type === "function_call") {
      names.set(item.call_id, item.name);
      const call = { callId: item.call_id, name: item.name, input: parseJson(item.arguments) };
      const last = messages.at(-1);
      if (last?.role === "assistant") last.toolCalls = [...(last.toolCalls ?? []), call];
      else messages.push({ role: "assistant", content: "", toolCalls: [call] });
    } else {
      messages.push({
        role: "tool",
        callId: item.call_id,
        toolName: names.get(item.call_id) ?? "",
        output: parseJson(item.output),
      });
    }
  }
  return { instructions, messages };
}

function billedOf(usage: unknown): Inspection["billed"] {
  const u = usage as
    | { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }
    | undefined;
  if (u?.input_tokens === undefined) return null;
  return {
    input: u.input_tokens,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

const failed = (where: string, error: unknown) => `${where} threw: ${(error as Error).message ?? String(error)}`;

/**
 * One recorded call, as the lab shows it: the body sent, the reply read `readSize` bytes at a time by the learner's
 * `parseSse` and `responsesChatModel` (the reference when no step slots them), and the tokens counted against the
 * tokens billed.
 */
export async function inspectCassette(name: CassetteName, readSize: number): Promise<Inspection> {
  const recorded = cassette(name);
  const bytes = new TextEncoder().encode(recorded.body);
  const body = recorded.request as unknown as RecordedBody;
  const out: Inspection = {
    name,
    title: recorded.title,
    request: JSON.stringify(recorded.request, null, 2),
    contentType: recorded.contentType,
    bytes: bytes.length,
    reads: Math.ceil(bytes.length / readSize),
    events: null,
    chatEvents: null,
    response: null,
    error: null,
    counted: null,
    billed: null,
  };

  try {
    const { instructions, messages } = messagesOf(body);
    const tools: ToolSpec[] = (body.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
    const schema = body.text?.format?.schema;
    out.counted = {
      ...countRequestTokens({ instructions, messages, tools }),
      schema: schema === undefined ? 0 : countTokens(JSON.stringify(schema)),
    };
  } catch (error) {
    out.error = failed("countRequestTokens", error);
  }

  if (recorded.contentType === "application/json") {
    const reply = JSON.parse(recorded.body) as { usage?: unknown };
    out.response = JSON.stringify(reply, null, 2);
    out.billed = billedOf(reply.usage);
    return out;
  }

  try {
    out.events = [];
    for await (const event of parseSse(chunkedBody(bytes, readSize))) {
      const data = parseJson(event.data) as { type?: unknown; response?: { usage?: unknown } } | string;
      const type = typeof data === "object" && typeof data.type === "string" ? data.type : null;
      if (type === "response.completed" && typeof data === "object") out.billed = billedOf(data.response?.usage);
      out.events.push({
        index: out.events.length + 1,
        event: event.event ?? null,
        type,
        data: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      });
    }
  } catch (error) {
    out.error ??= failed("parseSse", error);
    return out;
  }

  try {
    // The replay answers with the recording whatever the request says, so an empty one will do.
    const { fetch } = cassetteFetch([name], { readSize });
    const model = responsesChatModel({ model: "gpt-6-luna", apiKey: "sk-replay", fetch });
    out.chatEvents = [];
    for await (const event of model.stream({ instructions: "", messages: [], reasoningEffort: "medium" })) {
      out.chatEvents.push({
        type: event.type,
        delta: event.type === "text-delta" ? event.delta : null,
        json: JSON.stringify(event),
      });
    }
  } catch (error) {
    out.error ??= failed("responsesChatModel", error);
  }
  return out;
}
