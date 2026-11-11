/**
 * Optional associative-memory port. The Markdown vault never reads this.
 * Implementations must not throw: a down sidecar degrades to an empty answer.
 */
export interface NeuralDocument {
  id: string;
  title: string;
  aliases: string[];
  content: string;
  revision?: string;
}

export interface NeuralHit {
  id: string;
  score: number;
}

export interface NeuralAssociateResponse {
  available: boolean;
  results: NeuralHit[];
  warning?: string;
  /** Dense-vector layer (semantic similarity). Absent when the sidecar has vectors off. */
  vectorAvailable?: boolean;
  vectorResults?: NeuralHit[];
}

export interface NeuralRebuildResponse {
  available: boolean;
  indexed: number;
  warning?: string;
}

export interface NeuralHealth {
  enabled: boolean;
  available: boolean;
  entities?: number;
  warning?: string;
}

export interface NeuralAssociativeMemory {
  readonly enabled: boolean;
  upsert(document: NeuralDocument): Promise<void>;
  remove(id: string): Promise<void>;
  associate(query: string, limit: number): Promise<NeuralAssociateResponse>;
  rebuild(documents: NeuralDocument[]): Promise<NeuralRebuildResponse>;
  health(): Promise<NeuralHealth>;
}
