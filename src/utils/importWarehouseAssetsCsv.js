require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { applyAuditContext } = require('./auditContext');
const {
  ensureWarehouseShape,
  normalizeWarehouseAssetPayload,
  shouldImportWarehouseAsset,
  upsertWarehouseAsset,
} = require('../modules/warehouse/warehouse.service');

const pool = db.pool;
const shouldApply = process.argv.includes('--apply');
const targetPath = process.argv.slice(2).find((value) => value !== '--apply');

if (!targetPath) {
  console.error('Uso: node src/utils/importWarehouseAssetsCsv.js <ruta_csv> [--apply]');
  process.exit(1);
}

const parseDelimited = (content, delimiter = ';') => {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(current);
      current = '';
      if (row.some((value) => value.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    row.push(current);
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row);
    }
  }

  return rows;
};

const normalizeHeader = (value) => {
  return value
    .toString()
    .trim()
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const makeUniqueHeaders = (headers) => {
  const seen = new Map();
  return headers.map((header) => {
    const normalized = normalizeHeader(header) || 'column';
    const count = seen.get(normalized) ?? 0;
    seen.set(normalized, count + 1);
    return count === 0 ? normalized : `${normalized}_${count + 1}`;
  });
};

const mapCsvRowToAsset = (row) => ({
  asset_code: row.equipo,
  legacy_item_code: row.item,
  asset_name: row.descripcion,
  certification_note: row.f_certificacion,
  event_date: row.fecha,
  work_order: row.ot,
  client_name: row.cliente,
  dispatch_note: row.remision,
  asset_status: row.estado,
  brand: row.marca,
  serial_number: row.serial,
  model: row.modelo,
  audit_date: row.auditoria,
  current_city: row.ciudad,
  technical_detail: row.descripcion_2,
  notes: row.nota,
});

async function main() {
  const fullPath = path.resolve(targetPath);
  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const rows = parseDelimited(rawContent, ';');
  if (rows.length <= 1) {
    console.error('El CSV no tiene filas suficientes para importar.');
    process.exit(1);
  }

  const [headerRow, ...dataRows] = rows;
  const headers = makeUniqueHeaders(headerRow);
  const rawItems = dataRows.map((values) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = values[index] ?? '';
    });
    return item;
  });

  const normalizedAssets = rawItems
    .map(mapCsvRowToAsset)
    .map(normalizeWarehouseAssetPayload);

  const importableAssets = normalizedAssets.filter(shouldImportWarehouseAsset);
  const skippedAssets = normalizedAssets.length - importableAssets.length;

  console.log(`Archivo: ${fullPath}`);
  console.log(`Filas leidas: ${normalizedAssets.length}`);
  console.log(`Activos importables: ${importableAssets.length}`);
  console.log(`Filas omitidas: ${skippedAssets}`);

  if (!shouldApply) {
    console.log('Ejecucion en modo simulacion. Usa --apply para guardar en base de datos.');
    return;
  }

  const connection = await pool.getConnection();
  try {
    await ensureWarehouseShape(connection);
    await applyAuditContext(connection, {
      user: { id: null },
      headers: {},
      ip: '127.0.0.1',
    });
    await connection.beginTransaction();

    for (const asset of importableAssets) {
      await upsertWarehouseAsset(connection, asset);
    }

    await connection.commit();
    console.log(`Importacion completada. Activos guardados: ${importableAssets.length}`);
  } catch (error) {
    await connection.rollback();
    console.error('Error importando activos:', error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
  }
}

main().catch((error) => {
  console.error('Fallo ejecutando importacion:', error.message);
  process.exit(1);
});