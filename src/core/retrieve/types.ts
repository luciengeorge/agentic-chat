/** Built by `getViewer()` on the server, never from anything the client sends. */
export interface Viewer {
  tenantId: string;
  userId: string;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  path: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  score: number;
}

export interface Retrieval {
  query: string;
  rewritten: string[];
  chunks: RetrievedChunk[];
  auditId: string;
  /** With HyDE on: the passage the model wrote and search embedded. */
  hypothetical?: string;
  /** With routing on: the documents search was narrowed to, best first. */
  routedDocumentIds?: string[];
}

export interface RetrieveOptions {
  k?: number;
}

/** Implemented by `retrieve` in `#learn/retrieve/retrieve`. */
export type Retrieve = (viewer: Viewer, query: string, options?: RetrieveOptions) => Promise<Retrieval>;
