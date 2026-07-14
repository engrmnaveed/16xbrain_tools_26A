// ---------------------------------------------------------------------------
// 16xDataFlux — SQL → NoSQL (Document) Transformation Engine
// Deterministic heuristics that mirror how a data engineer designs a
// document model: embed 1:1 and bounded 1:N children, reference shared or
// unbounded data, dissolve junction tables into arrays.
// Every decision carries a human-readable rationale (also fed to the AI layer).
// ---------------------------------------------------------------------------

const UNBOUNDED_HINTS = /(transaction|log|event|message|payment|audit|history|activity|result)/i;

function inboundRefs(schema, tableName) {
  return schema.relationships.filter((r) => r.to === tableName);
}
function outboundRefs(schema, tableName) {
  return schema.relationships.filter((r) => r.from === tableName);
}

/**
 * Transform parsed SQL schema → document model.
 * Returns { collections, decisions, dissolvedJoins }
 */
export function toDocumentModel(schema) {
  const decisions = [];
  const embeddedInto = new Map(); // childTable -> parentTable
  const dissolved = new Set();

  // Pass 1: dissolve junction tables into arrays on one side
  for (const t of schema.tables) {
    if (!t.junction) continue;
    const fks = t.columns.filter((c) => c.fk);
    if (fks.length !== 2) continue;
    const [a, b] = fks;
    // Self-referencing junctions (e.g. follows) keep on the "owner" side
    const host = a.fk.table === b.fk.table ? a.fk.table : a.fk.table;
    const target = a.fk.table === b.fk.table ? b.fk.table : b.fk.table;
    dissolved.add(t.name);
    embeddedInto.set(t.name, host);
    decisions.push({
      table: t.name,
      action: 'dissolve',
      into: host,
      detail: `Junction table "${t.name}" dissolves into an array of ${target} references inside each ${singular(host)} document — the M:N JOIN disappears entirely.`
    });
  }

  // Pass 2: decide embed vs reference for each remaining table
  for (const t of schema.tables) {
    if (dissolved.has(t.name)) continue;
    const out = outboundRefs(schema, t.name);
    const inb = inboundRefs(schema, t.name).filter((r) => !dissolved.has(r.from));

    // Root candidates: no FKs out, or referenced by many
    if (out.length === 0) {
      decisions.push({
        table: t.name,
        action: 'collection',
        detail: `"${t.name}" becomes a root collection — it owns its own lifecycle.`
      });
      continue;
    }

    // Single parent FK → candidate for embedding
    const parentRels = out.filter((r) => r.to !== t.name); // ignore self-refs
    if (parentRels.length >= 1) {
      // Primary parent = the CASCADE relationship if there is one (ownership signal)
      const primary = parentRels.find((r) => r.onDelete === 'CASCADE') || parentRels[0];
      const cascade = primary.onDelete === 'CASCADE';
      const oneToOne = primary.type === 'one-to-one';
      const unbounded = UNBOUNDED_HINTS.test(t.name) || t.columns.some((c) => /BIGINT/.test(c.type) && c.pk);
      const sharedChild = inb.length > 0; // others point at this table → must stay addressable

      if (oneToOne && !sharedChild) {
        embeddedInto.set(t.name, primary.to);
        decisions.push({
          table: t.name,
          action: 'embed-object',
          into: primary.to,
          detail: `1:1 with "${primary.to}" — embed as a sub-document. One read instead of a JOIN.`
        });
        continue;
      }
      if (cascade && !sharedChild && !unbounded) {
        embeddedInto.set(t.name, primary.to);
        const others = parentRels.filter((r) => r !== primary).map((r) => r.to);
        decisions.push({
          table: t.name,
          action: 'embed-array',
          into: primary.to,
          detail: `Child of "${primary.to}" with CASCADE delete and no external readers — embed as an array${others.length ? ` (keeping references to ${others.join(', ')})` : ''}. The ${t.name} ⟷ ${primary.to} JOIN is eliminated.`
        });
        continue;
      }
      decisions.push({
        table: t.name,
        action: 'collection-ref',
        refs: parentRels.map((r) => r.to),
        detail: unbounded
          ? `"${t.name}" grows without bound — keep as its own collection with references (embedding would blow past document size limits).`
          : sharedChild
            ? `"${t.name}" is referenced by other tables — keep as its own collection so it stays addressable.`
            : `"${t.name}" links to multiple parents — keep as a collection with references.`
      });
      continue;
    }

    decisions.push({
      table: t.name,
      action: 'collection',
      detail: `"${t.name}" becomes a root collection.`
    });
  }

  // Build the collection documents
  const collections = [];
  for (const t of schema.tables) {
    if (dissolved.has(t.name) || embeddedInto.has(t.name)) continue;
    collections.push(buildDocument(schema, t, embeddedInto, dissolved, decisions));
  }

  const dissolvedJoins = countEliminatedJoins(schema, embeddedInto, dissolved);
  return { collections, decisions, embeddedInto, dissolved, ...dissolvedJoins };
}

function singular(name) {
  return name.replace(/ies$/, 'y').replace(/s$/, '');
}

const sqlToBson = (type) => {
  if (/INT|SERIAL|BIGINT/i.test(type)) return 'int';
  if (/DECIMAL|NUMERIC|FLOAT|DOUBLE/i.test(type)) return 'double';
  if (/BOOL/i.test(type)) return 'bool';
  if (/DATE|TIME/i.test(type)) return 'date';
  return 'string';
};

function buildDocument(schema, table, embeddedInto, dissolved, decisions) {
  const fields = [];
  for (const c of table.columns) {
    if (c.fk && embeddedInto.get(c.fk.table) === undefined && !dissolved.has(c.fk.table)) {
      // FK to a standalone collection → DBRef-style reference
      if (c.fk.table !== table.name) {
        fields.push({ name: c.name.replace(/_id$/, 'Ref'), type: `ref → ${c.fk.table}`, ref: c.fk.table, fromColumn: c.name });
        continue;
      }
    }
    if (c.pk && /INT|SERIAL/i.test(c.type)) {
      fields.push({ name: '_id', type: 'ObjectId', pk: true });
      continue;
    }
    if (c.fk && c.fk.table === table.name) {
      fields.push({ name: c.name.replace(/_id$/, 'Ref'), type: `ref → ${table.name}`, ref: table.name });
      continue;
    }
    if (c.fk) continue; // FK into an embedded parent chain — drop, structure encodes it
    fields.push({ name: toCamel(c.name), type: sqlToBson(c.type) });
  }

  // Attach embedded children
  const children = [...embeddedInto.entries()].filter(([, parent]) => parent === table.name);
  for (const [childName] of children) {
    const child = schema.tables.find((t) => t.name === childName);
    if (!child) continue;
    const d = decisions.find((x) => x.table === childName);
    if (d?.action === 'dissolve') {
      const fks = child.columns.filter((c) => c.fk);
      const other = fks.find((c) => c.fk.table !== table.name) || fks[1] || fks[0];
      fields.push({
        name: `${toCamel(other ? other.name.replace(/_id$/, '') : childName)}Ids`,
        type: `array<ref → ${other ? other.fk.table : childName}>`,
        dissolvedFrom: childName
      });
    } else if (d?.action === 'embed-object') {
      fields.push({
        name: toCamel(singular(childName)),
        type: 'sub-document',
        embedded: childName,
        subFields: embedFields(child, table.name)
      });
    } else {
      fields.push({
        name: toCamel(childName),
        type: 'array<sub-document>',
        embedded: childName,
        subFields: embedFields(child, table.name)
      });
    }
  }

  return { name: table.name, fields, sourceTable: table.name };
}

function embedFields(child, parentName) {
  return child.columns
    .filter((c) => !(c.fk && c.fk.table === parentName) && !(c.pk && /INT|SERIAL/i.test(c.type)))
    .map((c) => ({
      name: toCamel(c.name),
      type: c.fk ? `ref → ${c.fk.table}` : sqlToBson(c.type)
    }));
}

function toCamel(s) {
  return s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

function countEliminatedJoins(schema, embeddedInto, dissolved) {
  const eliminated = [];
  const remaining = [];
  for (const r of schema.relationships) {
    const fromGone = embeddedInto.has(r.from) || dissolved.has(r.from);
    if (fromGone) {
      eliminated.push(r);
    } else {
      remaining.push(r);
    }
  }
  return { eliminatedJoins: eliminated, remainingRefs: remaining };
}

/** Render a collection as pretty JSON sample */
export function collectionToJson(col) {
  const obj = {};
  for (const f of col.fields) {
    obj[f.name] = fieldSample(f);
  }
  return JSON.stringify(obj, null, 2);
}

function fieldSample(f) {
  if (f.type === 'ObjectId') return 'ObjectId("65f1a…")';
  if (f.type.startsWith('ref')) return `ObjectId("→ ${f.ref || f.type.split('→ ')[1]}")`;
  if (f.type.startsWith('array<ref')) return ['ObjectId("…")', 'ObjectId("…")'];
  if (f.type === 'sub-document') return sub(f.subFields);
  if (f.type === 'array<sub-document>') return [sub(f.subFields)];
  if (f.type === 'int') return 42;
  if (f.type === 'double') return 19.99;
  if (f.type === 'bool') return true;
  if (f.type === 'date') return 'ISODate("2026-07-12")';
  return '…';
}
function sub(fields = []) {
  const o = {};
  for (const f of fields) o[f.name] = fieldSample(f);
  return o;
}
