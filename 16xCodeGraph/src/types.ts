export type EntityKind =
  | "function"
  | "component"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export interface Entity {
  id: number;
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
  entity: Entity;
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
  fallbackEnabled: boolean;
}

export interface ScanStatus {
  state: "idle" | "scanning" | "done" | "error";
  rootPath: string | null;
  totalFiles: number;
  scannedFiles: number;
  entityCount: number;
  skippedUnchanged: number;
  error: string | null;
}

export type RefactorEvent =
  | { type: "prompt_meta"; chars: number; deps: number }
  | { type: "token"; token: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string; kind: string; provider?: string };
