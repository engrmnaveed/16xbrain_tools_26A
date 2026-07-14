import React from 'react';

export default function DocsView() {
  return (
    <div className="view">
      <div className="docs">
        <h1>SchemaMind — built-in guide</h1>
        <p className="sub">Everything the app can do, in five minutes. A 16xbrains tool — 16xbrains.com</p>

        <h2>1. Three ways to design a schema</h2>
        <p><strong>Visual:</strong> double-click the canvas to create a table. Drag headers to arrange. Select a table to edit fields, flags (PK, unique, required, index), defaults, enums and notes in the right-hand inspector. Link tables with the "Add relation" panel — the FK field can be auto-created.</p>
        <p><strong>Script:</strong> the Script tab shows your whole schema as <code>SchemaScript</code>, a plain-text DSL. Edit it and hit <span className="kbd">⌘/Ctrl + Enter</span> to apply. Diagram and script stay in sync both ways.</p>
        <p><strong>Plain English:</strong> at the bottom of the Script tab, type something like <em>"a ride-hailing app with drivers, riders, trips, payments and ratings"</em> and press ✦ Generate. The AI writes SchemaScript and it lands on your diagram. Keep "merge" checked to extend the current schema instead of replacing it.</p>

        <h2>2. SchemaScript reference</h2>
        <pre>{`table users {
  note: "Registered accounts"
  id uuid pk
  email string unique !null
  role enum(admin, member, guest) default(member)
  bio text note("shown on profile")
  created_at datetime default(now) index
}

table orders {
  id int pk default(autoincrement)
  total decimal !null
  status enum(pending, paid, shipped)
}

// relations (after tables)
ref orders.user_id > users.id            // many-to-one
ref profiles.user_id - users.id          // one-to-one
ref posts.id <> tags.id                  // many-to-many
ref invoices.order_id > orders.id [delete: restrict]`}</pre>
        <p>Types: <code>uuid int bigint float decimal string text boolean date datetime time json binary enum</code>. Modifiers: <code>pk unique !null index default(…) note("…")</code>. Defaults <code>now</code>, <code>uuid</code>, <code>autoincrement</code> are translated per export target. FK fields referenced in a <code>ref</code> are auto-created if missing.</p>

        <h2>3. AI assistance (OpenRouter)</h2>
        <p>Add your OpenRouter key in <strong>Settings</strong>. AI is embedded exactly where you work — there is no chat window:</p>
        <ul>
          <li><strong>✦ Generate</strong> (Script tab) — plain English → complete schema.</li>
          <li><strong>✦ Suggest</strong> (Inspector) — proposes missing fields for the selected table; accept each with one click.</li>
          <li><strong>✦ Review</strong> (toolbar) — scores your design and lists concrete findings: normalization, indexes, constraints, naming. Click a finding to jump to the table.</li>
          <li><strong>✦ Relations</strong> (toolbar) — finds relations you likely forgot and adds them after your confirmation.</li>
          <li><strong>✦ Docs</strong> (toolbar) — writes onboarding documentation for the schema, saveable as Markdown.</li>
        </ul>

        <h2>4. Import</h2>
        <ul>
          <li><strong>SQL DDL</strong> — CREATE TABLE from PostgreSQL, MySQL or SQLite; FKs become drawn relations.</li>
          <li><strong>JSON</strong> — paste a sample payload; nested arrays/objects become child tables with FKs (also in the JSON tab).</li>
          <li><strong>CSV / Excel</strong> — headers become fields, types inferred from sample values; each worksheet becomes a table.</li>
          <li><strong>SchemaScript / DBML-like text</strong> and full <strong>.schemamind.json</strong> projects.</li>
        </ul>

        <h2>5. Export</h2>
        <p>SQL DDL (PostgreSQL, MySQL, SQLite), Mongoose models, MongoDB collection validators, Prisma schema, TypeScript interfaces, JSON Schema, DBML for dbdiagram.io, a Markdown data dictionary, and an Excel data-dictionary workbook. Every export has a live preview and copy button.</p>

        <h2>6. Random data generator</h2>
        <p>The Data tab generates realistic rows: emails look like emails, prices like prices, cities like cities — inferred from field names and types. Foreign keys sample real parent rows in dependency order, so the dataset always satisfies referential integrity. Set a seed for reproducible datasets, and per-table row counts. Export as JSON, CSV, Excel, SQL INSERTs or Mongo <code>insertMany</code>.</p>

        <h2>7. Projects & shortcuts</h2>
        <p>Projects are single portable <code>.schemamind.json</code> files — git-friendly, no accounts, no cloud. <span className="kbd">⌘/Ctrl+N</span> new · <span className="kbd">⌘/Ctrl+O</span> open · <span className="kbd">⌘/Ctrl+S</span> save · <span className="kbd">⌘/Ctrl+Z</span> undo · <span className="kbd">⇧⌘/Ctrl+Z</span> redo · <span className="kbd">⌘/Ctrl+I</span> import · <span className="kbd">⌘/Ctrl+E</span> export.</p>

        <h2>8. Privacy</h2>
        <p>SchemaMind is local-first. Your schemas never leave your machine except when you explicitly trigger an AI action, which sends the schema text to OpenRouter using your own key.</p>
      </div>
    </div>
  );
}
