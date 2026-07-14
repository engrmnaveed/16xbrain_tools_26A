import crypto from "crypto";
import path from "path";
import {
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  VariableDeclaration,
} from "ts-morph";
import * as store from "./db";
import { EntityKind } from "./types";

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo",
  "coverage", ".cache", "target", "vendor",
]);

const MAX_ENTITY_CODE_CHARS = 60_000; // safety cap for giant entities

interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  signature: string | null;
  code: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** identifier names referenced inside the entity body */
  referencedNames: Set<string>;
}

interface FileExtraction {
  filePath: string;
  fileId: number;
  entities: { dbId: number; extracted: ExtractedEntity }[];
  /** imported name -> absolute path of the module that declares it */
  importMap: Map<string, string>;
}

export interface ScanProgress {
  totalFiles: number;
  scannedFiles: number;
  entityCount: number;
  skippedUnchanged: number;
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function collectReferencedNames(node: Node, ownName: string): Set<string> {
  const names = new Set<string>();
  node.forEachDescendant((d) => {
    if (d.getKind() !== SyntaxKind.Identifier) return;
    const parent = d.getParent();
    if (!parent) return;
    // skip `x` in `obj.x` — only the left-most expression is a real reference
    if (
      parent.getKind() === SyntaxKind.PropertyAccessExpression &&
      (parent as any).getNameNode?.() === d
    )
      return;
    // skip property names in object literals / declarations
    const pk = parent.getKind();
    if (
      pk === SyntaxKind.PropertyAssignment &&
      (parent as any).getNameNode?.() === d
    )
      return;
    const text = d.getText();
    if (text !== ownName) names.add(text);
  });
  return names;
}

function buildSignature(node: Node, name: string, kind: EntityKind): string {
  try {
    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
      const params = node.getParameters().map((p) => p.getText()).join(", ");
      const ret = node.getReturnTypeNode()?.getText() ?? "";
      return `function ${name}(${params})${ret ? `: ${ret}` : ""}`;
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      const params = node.getParameters().map((p) => p.getText()).join(", ");
      const ret = node.getReturnTypeNode()?.getText() ?? "";
      return `const ${name} = (${params})${ret ? `: ${ret}` : ""} => …`;
    }
    if (Node.isClassDeclaration(node)) {
      const methods = node
        .getMethods()
        .map((m) => {
          const params = m.getParameters().map((p) => p.getName()).join(", ");
          return `  ${m.getName()}(${params})`;
        })
        .join("\n");
      const ext = node.getExtends()?.getText();
      return `class ${name}${ext ? ` extends ${ext}` : ""} {\n${methods}\n}`;
    }
    if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
      const text = node.getText();
      return text.length > 800 ? text.slice(0, 800) + " …" : text;
    }
  } catch {
    /* signatures are best-effort */
  }
  return `${kind} ${name}`;
}

function extractFromFile(sourceFile: SourceFile): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const isTsx = sourceFile.getFilePath().endsWith(".tsx");

  const push = (
    node: Node,
    name: string,
    kind: EntityKind,
    exported: boolean,
    sigNode: Node = node
  ) => {
    let code = node.getText();
    if (code.length > MAX_ENTITY_CODE_CHARS)
      code = code.slice(0, MAX_ENTITY_CODE_CHARS) + "\n// …truncated…";
    out.push({
      name,
      kind,
      signature: buildSignature(sigNode, name, kind),
      code,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      exported,
      referencedNames: collectReferencedNames(node, name),
    });
  };

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const kind: EntityKind = isTsx && isPascalCase(name) ? "component" : "function";
    push(fn, name, kind, fn.isExported());
  }

  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    push(cls, name, "class", cls.isExported());
  }

  for (const i of sourceFile.getInterfaces()) push(i, i.getName(), "interface", i.isExported());
  for (const t of sourceFile.getTypeAliases()) push(t, t.getName(), "type", t.isExported());
  for (const e of sourceFile.getEnums()) push(e, e.getName(), "enum", e.isExported());

  // const Foo = () => …  /  const useBar = function () …  /  plain consts
  for (const v of sourceFile.getVariableDeclarations()) {
    const name = v.getName();
    const init = v.getInitializer();
    if (!init) continue;
    const stmt = v.getVariableStatement();
    const exported = stmt?.isExported() ?? false;
    const isFn =
      Node.isArrowFunction(init) || Node.isFunctionExpression(init);
    if (isFn) {
      const kind: EntityKind = isTsx && isPascalCase(name) ? "component" : "function";
      push(fullDeclNode(v), name, kind, exported, init);
    } else if (exported) {
      // exported non-function consts (configs, schemas…) are worth indexing
      push(fullDeclNode(v), name, "variable", true);
    }
  }

  return out;
}

/** prefer the whole `const x = …` statement so stored code is self-contained */
function fullDeclNode(v: VariableDeclaration): Node {
  return v.getVariableStatement() ?? v;
}

export async function scanProject(
  rootPath: string,
  onProgress: (p: ScanProgress) => void
): Promise<ScanProgress> {
  const project = new Project({
    compilerOptions: {
      allowJs: false,
      skipLibCheck: true,
      noResolve: false,
    },
    skipAddingFilesFromTsConfig: true,
  });

  const exclude = [...EXCLUDED_DIRS].map((d) => `!${rootPath}/**/${d}/**`);
  project.addSourceFilesAtPaths([
    `${rootPath}/**/*.ts`,
    `${rootPath}/**/*.tsx`,
    ...exclude,
  ]);

  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().endsWith(".d.ts"))
    .filter((sf) => {
      const rel = path.relative(rootPath, sf.getFilePath());
      return !rel.split(path.sep).some((seg) => EXCLUDED_DIRS.has(seg));
    });

  const progress: ScanProgress = {
    totalFiles: sourceFiles.length,
    scannedFiles: 0,
    entityCount: 0,
    skippedUnchanged: 0,
  };
  onProgress(progress);

  const livePaths = new Set<string>();
  const extractions: FileExtraction[] = [];

  // ---- pass 1: extract entities from new/changed files --------------------
  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    livePaths.add(filePath);
    const hash = sha1(sf.getFullText());
    const existing = store.getFile(filePath);

    if (existing && existing.hash === hash) {
      progress.skippedUnchanged++;
      progress.scannedFiles++;
      if (progress.scannedFiles % 25 === 0) onProgress(progress);
      continue;
    }

    const importMap = new Map<string, string>();
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue; // external package — not part of the graph
      const targetPath = target.getFilePath();
      for (const named of imp.getNamedImports())
        importMap.set(named.getAliasNode()?.getText() ?? named.getName(), targetPath);
      const def = imp.getDefaultImport();
      if (def) importMap.set(def.getText(), targetPath);
    }

    const extracted = extractFromFile(sf);

    let fileId = 0;
    const inserted: { dbId: number; extracted: ExtractedEntity }[] = [];
    store.runInTransaction(() => {
      fileId = store.replaceFile(filePath, rootPath, hash);
      for (const e of extracted) {
        const dbId = store.insertEntity({
          fileId,
          name: e.name,
          kind: e.kind,
          signature: e.signature,
          code: e.code,
          startLine: e.startLine,
          endLine: e.endLine,
          exported: e.exported,
        });
        inserted.push({ dbId, extracted: e });
      }
    });

    extractions.push({ filePath, fileId, entities: inserted, importMap });
    progress.entityCount += extracted.length;
    progress.scannedFiles++;
    if (progress.scannedFiles % 10 === 0) onProgress(progress);
    // yield to the event loop so /scan/status stays responsive
    if (progress.scannedFiles % 50 === 0) await new Promise((r) => setImmediate(r));
  }

  store.pruneMissingFiles(rootPath, livePaths);

  // ---- pass 2: resolve dependencies (same file first, then imports) -------
  const entityMap = store.loadEntityMap();
  store.runInTransaction(() => {
    for (const fx of extractions) {
      for (const { dbId, extracted } of fx.entities) {
        const deps: { targetId: number | null; targetName: string }[] = [];
        for (const ref of extracted.referencedNames) {
          const sameFile = entityMap.get(`${fx.filePath}::${ref}`);
          if (sameFile && sameFile !== dbId) {
            deps.push({ targetId: sameFile, targetName: ref });
            continue;
          }
          const importedFrom = fx.importMap.get(ref);
          if (importedFrom) {
            const target = entityMap.get(`${importedFrom}::${ref}`) ?? null;
            deps.push({ targetId: target, targetName: ref });
          }
          // bare identifiers that are neither local entities nor imports
          // (locals, params, globals) are intentionally ignored — no noise.
        }
        store.setDependencies(dbId, deps);
      }
    }
  });

  onProgress(progress);
  return progress;
}
