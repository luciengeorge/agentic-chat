---
title: halfvec, bit and rescoring
type: graded
slots:
  vectors/quantize: quantize.ts
  vectors/sizing: sizing.ts
---

# halfvec, bit and rescoring

👨‍💼 Kestrel's HNSW index is 44 MB for 5,637 chunks, and another big filing would double it. Truncation (step 4) cut the size and lost a quarter of the true neighbours. This step keeps all 1,536 dimensions and stores each one in less: 2 bytes, or 1 bit. Bits alone lose a lot; bits plus a second look at a few hundred full vectors lose almost nothing.

## Terms

- **Quantisation** stores numbers in fewer bits than they came in.
- `halfvec` is pgvector's half-precision type: each number in 2 bytes instead of 4, about 3 significant digits.
- **Binary quantisation** keeps one bit per number: 1 if it's above zero, 0 if not. A `bit(1536)` is 192 bytes of bits.
- **Hamming distance** counts the bits that differ between two bit strings (`<~>` in pgvector). Vectors pointing the same way have few.
- **Over-fetching** asks the index for more candidates than you need; **rescoring** sorts those candidates again by a more exact distance, and keeps the best.
- A **page** is the 8 KB block Postgres stores rows and index entries in.

## Do this

🐨 Two stubs. In `playground/sizing.ts`, write `bytesPerVector`: what one value of each type takes on disk. In `playground/quantize.ts`, write `binaryRescoreNearest`: candidates by Hamming distance from the bit index, the answer by full cosine. The tests need Postgres.

## A worked example

|                           |        bytes a vector | HNSW index, 5,637 vectors | recall@10 (bench) |
| ------------------------- | --------------------: | ------------------------: | ----------------: |
| `vector(1536)`            | 8 + 1,536 × 4 = 6,152 |                   44.0 MB |             86.7% |
| `halfvec(1536)`           | 8 + 1,536 × 2 = 3,080 |                   22.0 MB |             91.3% |
| `bit(1536)`, Hamming only |   8 + 1,536 / 8 = 200 |                    2.7 MB |             68.3% |
| `bit(1536)`, 200 rescored |                   200 |                    2.7 MB |             91.7% |

A 6,152-byte vector fills an 8 KB page by itself, so the full index takes one page per vector: in the test, 428 vectors make 429 pages (3,514,368 bytes), the extra one for the index's metadata. Over the 428 recorded vectors, bits alone find about 81% of the true top 10, and 200 rescored candidates find 100%.

Run the tests with `pnpm ex test 06.5`.
