---
title: Streaming by hand
type: graded
slots:
  model/responses: responses.ts
---

# Streaming by hand: the solution

`parseSse` keeps one `TextDecoder` and a text buffer for the whole body. Each read is decoded with `{ stream: true }`, its line endings turned into `\n`, and added to the buffer. Then every complete block (everything up to a blank line) is cut off the front and handed to `parseBlock`. What's left waits for the next read. When the body ends, the decoder is flushed and whatever is left in the buffer is the last event.

## Why it works

- **Events wait for their blank line.** A read ends wherever the network chose, so the end of a read means nothing. Only `\n\n` says an event is complete. The buffer holds the half events until it comes.
- **Characters wait for their last byte.** One decoder in stream mode remembers a character's first bytes when a read ends inside it, and finishes it on the next read. A new decoder per read can't: it sees half a "£" and writes the replacement character, "�".
- **A trailing CR waits for its LF.** If a read ends with `\r`, the solution holds that CR back and puts it in front of the next read before changing line endings. So `\r` + `\n` across two reads is still one line break. Two would make a blank line, and end an event that hasn't finished.
- **The last event isn't lost.** A stream may end without a final blank line. After the loop, the buffer (plus anything the decoder still held) is parsed as one more block.
- **The reader is released** in a `finally`, so a caller that stops reading early (an aborted answer) doesn't leave the body locked.

## The worked example

At 1,024 bytes a read, the recorded answer's 28,955 bytes come in 29 reads, and 21 of its 64 events straddle two of them. Cut between the two bytes of the "£" in event 13 (offsets 10,272 and 10,273) and the delta still reads "£". The client then yields the 54 deltas, "The London hotel limit is **£200 a night** under v2. [[S1: ...]]", and one finish: 598 tokens in, 113 out, 53 of them reasoning.

The AI SDK does the same job in `@ai-sdk/provider-utils` (its `EventSourceParserStream`). In step 4 you'll see it read this same recording into exactly the same events.
