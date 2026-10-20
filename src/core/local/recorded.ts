/**
 * The local reranker's real outputs for one golden question, recorded once (2026-10-21) so section 21's tests can
 * replay them without loading the 279 MB model. The question is `expenses-london-hotel`, "What is the nightly limit
 * for a hotel in London?", against four chunks from the dev database: version 2's limits table (the right answer,
 * page 2), version 1's (page 2), version 2's "What changed" table (page 4) and the Brightwell contacts table. Each
 * has bge-reranker-base's logit (int8, one pair per pass), and what transformers.js's text-classification pipeline
 * gave for the same pair and for the two texts joined: 1 every time. Recorded by a script that isn't committed: it
 * ran `loadCrossEncoder` and `pipeline("text-classification")` on the vendored weights.
 */
import type { CrossEncoder, Logits } from "#learn/local/rerank";

import recordingJson from "../../../fixtures/local/recordings/rerank-london-hotel.json?raw";

export interface RecordedPassage {
  path: string;
  page: number | null;
  text: string;
  logit: number;
  /** The pipeline's score for `{ text: query, text_pair: passage }`. */
  pipeline: number;
  /** The pipeline's score for the query and the passage joined into one text. */
  pipelineJoined: number;
}

export interface RerankRecording {
  query: string;
  model: string;
  passages: RecordedPassage[];
}

export const RERANK_RECORDING = JSON.parse(recordingJson) as RerankRecording;

/** One forward pass, as the stand-in saw it. */
export interface EncoderCall {
  queries: string[];
  pairs: string[];
}

/**
 * A stand-in for the cross-encoder: a tokenizer that pairs queries with passages as transformers.js's does (one
 * query per passage, or it throws), and a model that answers each pair's logit from `logitOf`, shaped [pairs, 1].
 * `calls` keeps every pass.
 */
export function standInEncoder(logitOf: (query: string, passage: string) => number) {
  const calls: EncoderCall[] = [];
  const encoder: CrossEncoder = {
    tokenize(queries, options) {
      if (!Array.isArray(queries) || !Array.isArray(options?.text_pair)) {
        throw new TypeError("tokenize takes an array of queries and { text_pair: an array of passages }");
      }
      if (queries.length !== options.text_pair.length) {
        throw new Error(
          `the tokenizer pairs queries[i] with text_pair[i]: got ${queries.length} queries for ${options.text_pair.length} passages`,
        );
      }
      calls.push({ queries: [...queries], pairs: [...options.text_pair] });
      return { queries: [...queries], pairs: [...options.text_pair] };
    },
    async classify(inputs) {
      const { queries, pairs } = inputs as EncoderCall;
      const logits: Logits = {
        data: Float32Array.from(pairs.map((pair, i) => logitOf(queries[i]!, pair))),
        dims: [pairs.length, 1],
      };
      return { logits };
    },
  };
  return { encoder, calls };
}

/** The stand-in on the recording: the recorded logit for the recorded query and a recorded passage, else -12. */
export function recordedEncoder(recording: RerankRecording = RERANK_RECORDING) {
  return standInEncoder((query, passage) => {
    const found = recording.passages.find((entry) => entry.text === passage);
    return query === recording.query && found ? found.logit : -12;
  });
}
