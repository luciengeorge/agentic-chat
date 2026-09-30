# Cohere & North — Primer

> The interview PDF says explicitly: *"Familiarise yourself with the context of Cohere: Study how a system similar to **North** is designed."*
>
> That's not a throwaway line. It's telling you the design exercise will be **North-shaped**: an enterprise AI agent / retrieval platform, with security and private deployment as first-class constraints.
>
> This doc is so you can speak their language fluently. Read it twice.

---

## 1. Cohere's positioning — the one sentence that explains everything

> **"Cohere is the leading security-first enterprise AI company."**

Everything follows from *security-first* and *enterprise*. They are **not** competing with OpenAI on consumer chat. They're competing for the bank, the government department, the hospital, the telco — organisations who cannot send their data to a third-party API.

Their whole moat is: **bring the AI to the data, not the data to the AI.**

If you internalise one thing before this interview, make it that sentence. Every design decision you propose should be defensible under the question *"does this keep customer data inside their perimeter?"*

**Target industries** (straight from their site): Financial Services, Public Sector, Healthcare & Life Sciences, Telecommunications, Energy & Utilities, Manufacturing, Technology.

Notice the pattern — all heavily regulated, all with data residency and compliance requirements. That's deliberate.

---

## 2. The product lineup (know these names cold)

### Platforms

| Product | What it is |
|---|---|
| **North** | The flagship. An enterprise AI platform where you build and deploy **AI agents and automations** inside your own infrastructure. Low-code. Connects to workplace tools (Gmail, Slack, Salesforce, Outlook, SharePoint). |
| **Compass** | Intelligent **search and discovery**. Cohere's managed end-to-end retrieval layer — parsing, chunking, embedding, indexing, and two-stage retrieval. Multimodal, multilingual, format-agnostic. This is the RAG engine underneath North. |

### Models

| Model | What it does | Where it fits in a RAG pipeline |
|---|---|---|
| **Command** | Generative LLM (their GPT-equivalent) | Generation — writes the final answer |
| **Embed** | Semantic embeddings | Indexing + first-stage retrieval |
| **Rerank** | Cross-encoder retrieval optimisation | Second-stage retrieval — precision |
| **Parse** | Document parsing | Ingestion — extracts text/structure from PDFs, slides, spreadsheets |
| **Transcribe** | Speech recognition | Ingestion — audio/video to text |
| **North Small Translate** | Machine translation | Multilingual ingestion + query |
| **Aya** | Multilingual research models (Cohere Labs) | Research / multilingual |

**This lineup is a complete RAG pipeline in Cohere's own products.** Parse → Embed → (index) → Embed query → Rerank → Command. If you draw an enterprise RAG architecture and label the boxes with these model names, you will look like you did your homework.

### Deployment

| Option | What it means |
|---|---|
| **SaaS / Cloud API** | Standard hosted API. The "easy" tier. |
| **Cloud provider marketplaces** | Deploy via AWS/Azure/GCP/Oracle. |
| **VPC deployment** | Runs inside the customer's own virtual private cloud (e.g. AWS EC2/EKS). Data doesn't leave their network boundary. |
| **On-premises** | Customer's own hardware, own GPUs, own data centre. |
| **Air-gapped** | Physically isolated from any external network. No internet at all. The hardest mode. |
| **Model Vault** | Cohere's dedicated model inference platform for isolated VPC / on-prem. **Model Vault Encrypted** adds confidential computing — inference runs encrypted, verifiable via remote attestation. |

**The stat worth quoting:** North can run privately on **as few as two GPUs**. That's a deliberate engineering achievement and a competitive weapon — it means a mid-size enterprise can run the whole stack on modest hardware in their own data centre. If the interviewer asks about resource constraints, referencing this shows you read their material.

---

## 3. What North actually does (the product shape)

Three layers, roughly:

**Layer 1 — Chat & Search.** Employees ask questions in natural language; North retrieves from across connected enterprise systems and answers with citations. This is the Compass/RAG layer surfaced as a product.

**Layer 2 — Agents.** Configurable agents with access to tools. An agent can search internal docs, call an API, read an email, update a CRM record. Low-code configuration so non-engineers can build them.

**Layer 3 — Automations.** Agentic *workflows* — multi-step processes that run on triggers or schedules, chaining agents and tools together. "When a support ticket comes in, search the knowledge base, draft a reply, route to the right team."

**Integrations** connect to the tools employees already use: Gmail, Slack, Salesforce, Outlook, SharePoint, and so on.

**Governance** is a first-class feature: zero-trust security model, role-based access control, document-level security, audit-ready monitoring, GDPR and SOC-2 compliance.

**Customer proof point:** CoreWeave used North to transform customer support in 90 days. Worth knowing as an example of the deployment story.

---

## 4. Compass — the retrieval engine (know this in detail)

Compass is the piece most likely to be the *technical* heart of your design exercise. Its architecture:

> **Native two-stage retrieval: high-recall embedding search, followed by high-precision cross-encoder ranking.**

That's the industry best practice for production RAG, and it's exactly what you should propose if asked to design retrieval. (The next doc explains *why* two stages, from first principles.)

Compass responsibilities:
- **Intelligent document parsing** — handles PDFs, slides, spreadsheets, images. Multimodal.
- **Automatic chunking** — splits documents into retrievable units
- **Semantic embedding** via Embed
- **Indexing** into a vector store
- **Two-stage retrieval** — Embed for recall, Rerank for precision
- **Role-based access control + document-level security** — critical, see below
- **Deployable into any VPC or on-prem environment**

---

## 5. The hard problem they care most about: permission-aware retrieval

This is the thing that separates enterprise RAG from a weekend RAG demo, and it's the single most likely place for the interviewer to probe hard.

**The problem:** an employee asks "what's our Q3 revenue forecast?" The system searches across SharePoint, Google Drive, Slack, Salesforce. Some of those documents the employee is allowed to see. Some — the exec comp spreadsheet, the unannounced acquisition memo — they absolutely are not.

**A naive RAG system leaks them.** The embedding index doesn't know about permissions. If you retrieve the top-10 semantically similar chunks and stuff them in the prompt, the LLM will happily summarise the acquisition memo for someone in the mailroom.

**The correct approach (know this):**

> **ACL = Access Control List.** The list of who is allowed to do what to a resource. Every file in SharePoint, every doc in Google Drive, every Slack channel has one — it's the record of which users, groups, and roles can read it. When you copy a document into your search index, you have to copy its ACL too, or you've just built a machine that ignores every permission your customer set up.

1. **Stamp ACLs onto chunks at ingestion time.** When you index a document, you also record who can see it — typically a set of principal IDs (users, groups, roles) copied from the source system.
2. **Filter at retrieval time, before the model sees anything.** The vector search is constrained by the user's principal set. Pre-filtering (narrow the candidate set first) or post-filtering (retrieve then drop) or hybrid.
3. **Never let unauthorised content reach the prompt.** Permission enforcement happens *before* generation, not after. You cannot ask the LLM to "please don't mention the confidential parts."
4. **Keep ACLs fresh.** Source-system permissions change constantly. Someone leaves a team, a doc gets reshared. You need incremental ACL sync, and you need to decide how stale is acceptable.
5. **Audit everything.** Log `(user_id, query, returned_chunk_ids, denied_chunk_ids, acl_version, timestamp)`. Regulated customers require this.

If you volunteer this unprompted in the interview, you will stand out. Most candidates design a RAG system and never mention permissions once.

---

## 6. Vocabulary cheat sheet

Terms to use correctly and confidently:

| Term | Meaning |
|---|---|
| **ACL** | Access Control List — the record of who can read/write a given resource. Copied from the source system at ingestion and stamped onto every chunk so retrieval can filter by it. |
| **Principal** | Any identity an ACL can name: a user, a group, or a role. "Resolving a user's principal set" means expanding them into every group and role they belong to. |
| **VPC** | Virtual Private Cloud — a logically isolated slice of a cloud provider's infrastructure that belongs to one customer, with its own private network. "Deploy into the customer's VPC" means the software runs on their cloud account, inside their network boundary, rather than on Cohere's. |
| **RAG** | Retrieval-Augmented Generation — retrieve relevant context, put it in the prompt, generate an answer grounded in it |
| **Embedding** | A vector of numbers representing the semantic meaning of a piece of text |
| **Bi-encoder** | Encodes query and document separately into vectors; fast, allows pre-computed index. This is Embed. |
| **Cross-encoder** | Encodes query and document *together*; much more accurate, much slower. Can't pre-compute. This is Rerank. |
| **Chunking** | Splitting documents into retrievable pieces |
| **ANN** | Approximate Nearest Neighbour — the algorithm class (HNSW, IVF) that makes vector search fast |
| **Hybrid search** | Combining semantic (vector) search with lexical (BM25 / keyword) search |
| **Grounding** | Ensuring the model's answer is supported by retrieved evidence |
| **Citation** | Linking generated claims back to source chunks — essential in enterprise |
| **Hallucination** | Model generating unsupported claims |
| **Tool calling / function calling** | LLM emitting a structured request to invoke an external function |
| **Agent loop** | Iterative cycle: model plans → calls tool → observes result → plans again → eventually answers |
| **Air-gapped** | Physically isolated from external networks |
| **Confidential computing** | Hardware-enforced encryption of data *in use* (during compute), not just at rest and in transit |
| **Remote attestation** | Cryptographic proof that a workload is running in a genuine, unmodified secure enclave |
| **Sovereign AI** | AI infrastructure that stays within a nation's or organisation's jurisdictional control |
| **Multi-tenancy** | One deployment serving multiple isolated customers |
| **KV cache** | Key-value cache in transformer inference — makes generating each subsequent token cheaper |
| **Continuous batching** | Inference serving technique that dynamically batches requests for GPU efficiency |

---

## 7. What Cohere's constraints imply for your design

Because they deploy on-prem and air-gapped, certain "obvious" cloud answers become **wrong**. Watch for these traps:

| Reflex answer | Why it's wrong at Cohere | What to say instead |
|---|---|---|
| "We'll use Pinecone / a managed vector DB" | SaaS dependency. Won't work air-gapped. | "A self-hostable vector store — pgvector, Qdrant, Weaviate, Milvus — so it ships inside the customer's perimeter." |
| "We'll call the OpenAI API" | Data leaves the perimeter. Entire anti-thesis. | "Models run locally on the customer's GPUs." |
| "We'll use S3 for document storage" | Assumes AWS. On-prem customers have NFS/MinIO. | "Object storage — S3 in cloud deployments, MinIO or equivalent on-prem." |
| "We'll auto-scale with Lambda" | Serverless doesn't exist on-prem. | "Containers on Kubernetes, which works in both cloud and on-prem." |
| "We'll send telemetry to Datadog" | Data egress from an air-gapped install is impossible. | "Self-hosted observability — Prometheus/Grafana — with optional export where the customer allows it." |
| "We'll fine-tune on customer data centrally" | Can't pool customer data. | "Per-tenant customisation that stays in their environment." |

**The meta-rule:** whenever you reach for a managed cloud service, ask yourself *"does this work in an air-gapped data centre?"* If not, name a self-hostable equivalent. Doing this unprompted is a very strong signal.

---

## 8. Likely framings of the design exercise

Ranked by how likely I think each is:

1. **"Design an enterprise AI assistant that answers questions over a company's internal documents"** — the core RAG system. Most likely.
2. **"Design a platform that lets enterprises build and deploy AI agents"** — North itself, agent orchestration focus.
3. **"Design a document ingestion and indexing pipeline for a large enterprise"** — Compass ingestion focus.
4. **"Design a system for serving LLM inference inside a customer's private cloud"** — Model Vault focus, infra-heavy.
5. **"Design a workflow automation system powered by LLM agents"** — North Automations focus.
6. **"Design enterprise search that respects document-level permissions"** — the security angle made explicit.

The next docs cover all six, with the first two in depth.

---

## 9. Three things to say that show you did the reading

Drop these naturally, don't force them:

- *"Since Cohere deploys into VPCs and on-prem — including air-gapped — I'll assume everything in this design has to run inside the customer's perimeter with no external dependencies. That rules out managed SaaS components."*
- *"I'd use a two-stage retrieval architecture — a bi-encoder for high-recall candidate generation, then a cross-encoder reranker for precision. That's the standard for production RAG and it's what Compass does."*
- *"The thing I'd want to get right early is permission-aware retrieval. In an enterprise, the failure mode isn't a bad answer — it's surfacing a document the user shouldn't have seen. That's a security incident, not a quality bug."*

Any one of those, delivered naturally, signals you understand their world rather than generic system design.

---

## Sources

- [Introducing North: The next era of enterprise AI — Cohere](https://cohere.com/blog/north-ga)
- [North: The AI Platform Where Work Flows — Cohere](https://cohere.com/north)
- [Compass: Intelligent Search and Discovery — Cohere](https://cohere.com/compass)
- [Orchestrate Agentic Workflows with North Automations — Cohere](https://cohere.com/blog/introducing-north-automations-ai-workflows)
- [Private Deployments for Ultimate AI Security — Cohere](https://cohere.com/private-deployments)
- [Deployment Options Overview — Cohere Docs](https://docs.cohere.com/docs/deployment-options-overview)
- [Cohere's North Platform Tackles Enterprise AI Agent Deployment Bottleneck](https://ai-agent-news.com/posts/cohere-north-enterprise-ai-agent-deployment/)
- [Cohere goes 'North' with agentic AI — InfoWorld](https://www.infoworld.com/article/3757962/cohere-goes-north-with-agentic-ai.html)
- [RAG with Access Control — Pinecone](https://www.pinecone.io/learn/rag-access-control/)
- [Document-Level RBAC for RAG Pipelines — Truto](https://truto.one/blog/how-to-maintain-document-level-rbac-in-enterprise-rag-pipelines/)
