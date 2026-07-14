// Excel (xlsx) import/export via SheetJS.
import * as XLSX from 'xlsx';
import { createTable, createField, sanitizeName } from '../model/schema.js';
import { EXPORT_FORMATS } from './exporters.js';

// Import: each worksheet becomes a table; column types inferred from cell values.
export function importExcel(base64) {
  const wb = XLSX.read(base64, { type: 'base64' });
  const tables = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
    if (!rows.length) continue;
    const table = createTable({ name: sanitizeName(sheetName), fields: [] });
    const keys = Object.keys(rows[0]);
    for (const key of keys) {
      const values = rows.slice(0, 50).map(r => r[key]).filter(v => v != null && v !== '');
      const f = createField({ name: sanitizeName(key), type: inferCellType(values) });
      if (f.name === 'id') { f.pk = true; f.nullable = false; }
      table.fields.push(f);
    }
    if (!table.fields.some(f => f.pk))
      table.fields.unshift(createField({ name: 'id', type: 'int', pk: true, nullable: false, default: 'autoincrement' }));
    tables.push(table);
  }
  if (!tables.length) throw new Error('No usable worksheets found in the Excel file.');
  return { tables, relations: [] };
}

function inferCellType(values) {
  if (!values.length) return 'string';
  if (values.every(v => typeof v === 'number')) return values.every(v => Number.isInteger(v)) ? 'int' : 'float';
  if (values.every(v => typeof v === 'boolean')) return 'boolean';
  if (values.every(v => v instanceof Date)) return 'datetime';
  if (values.every(v => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) return 'date';
  return 'string';
}

// Export the schema itself as a data-dictionary workbook (one sheet per table + overview).
export function exportSchemaWorkbook(project) {
  const wb = XLSX.utils.book_new();
  const overview = project.tables.map(t => ({
    Table: t.name, Fields: t.fields.length,
    PrimaryKey: t.fields.filter(f => f.pk).map(f => f.name).join(', '),
    Note: t.note || ''
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overview), 'Overview');
  for (const t of project.tables) {
    const rows = t.fields.map(f => ({
      Field: f.name, Type: f.type === 'enum' ? `enum(${f.enumValues.join('|')})` : f.type,
      PK: f.pk ? 'yes' : '', Unique: f.unique ? 'yes' : '', Nullable: f.nullable ? 'yes' : 'no',
      Indexed: f.indexed ? 'yes' : '', Default: f.default ?? '', Note: f.note || ''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), t.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

// Export generated data rows ({ tableName: rows[] }) as a workbook.
export function exportDataWorkbook(dataByTable) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(dataByTable)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

export { EXPORT_FORMATS };
