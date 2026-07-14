export type EntityKind =
  | "function"
  | "component"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export interface EntityRow {
  id: number;
  file_id: number;
  file_path: string;
  name: string;
  kind: EntityKind;
  signature: string | null;
  code: string;
  start_line: number;
  end_line: number;
  exported: number;
}

export interface DependencyInfo {
  id: number | null;
  name: string;
  kind: EntityKind | null;
  file_path: string | null;
  signature: string | null;
}

export interface EntityDetail {
  entity: EntityRow;
  dependencies: DependencyInfo[];
  dependents: DependencyInfo[];
}

export type LLMProvider = "ollama" | "openrouter";

export interface LLMSettings {
  provider: LLMProvider;
  ollamaEndpoint: string;
  ollamaModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  /** If the primary provider fails, try the other one (when configured). */
  fallbackEnabled: boolean;
}

export const DEFAULT_SETTINGS: LLMSettings = {
  provider: "ollama",
  ollamaEndpoint: "http://localhost:11434/api/generate",
  ollamaModel: "gemma2:9b",
  openrouterApiKey: "",
  openrouterModel: "google/gemma-2-9b-it",
  fallbackEnabled: false,
};

export interface ScanStatus {
  state: "idle" | "scanning" | "done" | "error";
  rootPath: string | null;
  totalFiles: number;
  scannedFiles: number;
  entityCount: number;
  skippedUnchanged: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}
