// ---------------------------------------------------------------
// OpenRouter integration — task-oriented AI, embedded in the workflow.
// No chatbox: each function is a single-purpose call wired into the UI.
// Settings (key + model) live in localStorage.
// ---------------------------------------------------------------

import { serializeProject, parseScript } from '../dsl/parser.js';

const SETTINGS_KEY = 'schemamind.ai';

export function getAISettings() {
  try {
    return { apiKey: '', model: 'anthropic/claude-sonnet-4.5', temperature: 0.4, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { apiKey: '', model: 'anthropic/claude-sonnet-4.5', temperature: 0.4 };
  }
}
export function saveAISettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
export const hasAIKey = () => !!getAISettings().apiKey;

export const SUGGESTED_MODELS = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-4.1',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat'
];

async function complete(system, user, { maxTokens = 4000 } = {}) {
  const { apiKey, model, temperature } = getAISettings();
  if (!apiKey) throw new Error('No OpenRouter API key set. Add one in Settings → AI.');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://16xbrains.com/tools/schemamind',
      'X-Title': 'SchemaMind'
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from model.');
  return text;
}

const DSL_SPEC = `SchemaScript DSL specification:
- Tables: "table name {" ... "}" — snake_case names.
- Fields: "  name type [modifiers]" one per line.
- Types (only these): uuid, int, bigint, float, decimal, string, text, boolean, date, datetime, time, json, binary, enum
- Enum: "status enum(active, inactive, banned)"
- Modifiers: pk, unique, !null, index, default(value), note("text")
- Defaults: default(now), default(uuid), default(autoincrement), default('literal')
- Relations after all tables: "ref child.fk_field > parent.pk_field" (many-to-one), "ref a.f - b.f" (one-to-one), "ref a.f <> b.f" (many-to-many). Optional "[delete: restrict]" or "[delete: set null]".
- Every table should have a pk. FK fields must exist or will be auto-created with the referenced field's type.
- Comments with //.
Output ONLY valid SchemaScript inside a \`\`\` code block, nothing else.`;

function extractCode(text) {
  const m = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

// ---------- Task: plain English → schema ----------
export async function englishToSchema(description, existingProject = null) {
  const ctx = existingProject && existingProject.tables.length
    ? `\n\nThe user already has this schema (you may reference its tables in refs, do NOT repeat them unless asked to modify):\n\`\`\`\n${serializeProject(existingProject)}\n\`\`\``
    : '';
  const text = await complete(
    `You are a senior data architect. Convert the user's plain-English description into a production-quality database schema.\nUse proper normalization, sensible types, timestamps (created_at/updated_at) where useful, junction tables for many-to-many, and indexes on FK and lookup fields.\n\n${DSL_SPEC}`,
    description + ctx
  );
  const code = extractCode(text);
  return { fragment: parseScript(code), script: code };
}

// ---------- Task: suggest fields for one table ----------
export async function suggestFields(project, table) {
  const text = await complete(
    `You are a senior data architect. Given a schema and one target table, suggest additional fields that a production system would likely need for that table. Do not repeat existing fields. Suggest 3-8 fields max.\n\n${DSL_SPEC}\n\nOutput a single table block for the target table containing ONLY the new suggested fields.`,
    `Full schema:\n\`\`\`\n${serializeProject(project)}\n\`\`\`\n\nTarget table: ${table.name}`
  );
  const code = extractCode(text);
  const parsed = parseScript(code);
  const t = parsed.tables.find(x => x.name === table.name) || parsed.tables[0];
  if (!t) throw new Error('The model did not return a parsable table.');
  const existing = new Set(table.fields.map(f => f.name.toLowerCase()));
  return t.fields.filter(f => !existing.has(f.name.toLowerCase()));
}

// ---------- Task: review the schema ----------
export async function reviewSchema(project) {
  const text = await complete(
    `You are a principal database engineer doing a schema review. Analyze for: normalization problems, missing indexes, missing constraints (unique/not-null), naming inconsistencies, missing timestamps/soft-delete where conventional, scalability risks, and missing relations.\nRespond with STRICT JSON only (no code fence): {"score": 0-100, "summary": "one paragraph", "findings": [{"severity": "high|medium|low", "table": "name or null", "issue": "...", "fix": "..."}]}. Maximum 12 findings, most important first.`,
    `\`\`\`\n${serializeProject(project)}\n\`\`\``
  );
  const raw = text.replace(/```(?:json)?/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('The model did not return valid JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------- Task: suggest relations ----------
export async function suggestRelations(project) {
  const text = await complete(
    `You are a data architect. Given a schema, identify relations that are probably missing (based on field names like user_id, order_id and domain logic). Output ONLY "ref" lines in SchemaScript syntax inside a code block. If none are missing, output an empty code block.\n\n${DSL_SPEC}`,
    `\`\`\`\n${serializeProject(project)}\n\`\`\`\n\nExisting refs are already in the schema above — do not repeat them.`
  );
  const code = extractCode(text);
  if (!code.trim()) return { relations: [], script: '' };
  // Parse refs against the existing project: serialize tables + new refs
  const full = serializeProject({ ...project, relations: [] }) + '\n' + code;
  const parsed = parseScript(full);
  // Map parsed relations back onto real project ids by table/field names
  const mapped = [];
  for (const r of parsed.relations) {
    const pft = parsed.tables.find(t => t.id === r.fromTable);
    const ptt = parsed.tables.find(t => t.id === r.toTable);
    const pff = pft?.fields.find(f => f.id === r.fromField);
    const ptf = ptt?.fields.find(f => f.id === r.toField);
    if (!pft || !ptt || !pff || !ptf) continue;
    const ft = project.tables.find(t => t.name === pft.name);
    const tt = project.tables.find(t => t.name === ptt.name);
    const ff = ft?.fields.find(f => f.name === pff.name);
    const tf = tt?.fields.find(f => f.name === ptf.name);
    if (!ft || !tt || !ff || !tf) continue;
    const dup = project.relations.some(x => x.fromTable === ft.id && x.fromField === ff.id && x.toTable === tt.id && x.toField === tf.id);
    if (dup) continue;
    mapped.push({ fromTable: ft.id, fromField: ff.id, toTable: tt.id, toField: tf.id, kind: r.kind, onDelete: r.onDelete });
  }
  return { relations: mapped, script: code };
}

// ---------- Task: explain / document the schema ----------
export async function explainSchema(project) {
  return complete(
    `You are a technical writer. Produce clear Markdown documentation of this database schema for a new developer joining the team: purpose of each table, key relationships, and any design decisions implied by the structure. Be concise but complete. Output Markdown only.`,
    `\`\`\`\n${serializeProject(project)}\n\`\`\``,
    { maxTokens: 3000 }
  );
}

// ---------- Task: name/describe a field's semantics for better fake data ----------
export async function refineTableNote(project, table) {
  return complete(
    `In 1-2 sentences, describe the purpose of the given table in its schema context. Output plain text only.`,
    `Schema:\n\`\`\`\n${serializeProject(project)}\n\`\`\`\nTable: ${table.name}`,
    { maxTokens: 200 }
  );
}
