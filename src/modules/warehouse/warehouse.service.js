const normalizeText = (value) => {
  const raw = (value ?? '').toString().trim();
  if (!raw) return null;

  const lowered = raw.toLowerCase();
  if (
    lowered === 'n' ||
    lowered === 'n.' ||
    lowered === 'n/a' ||
    lowered === 'n/a.' ||
    lowered === 'na' ||
    lowered === 'null' ||
    lowered === 'undefined' ||
    lowered === 'no visible' ||
    lowered === 'no visible.' ||
    lowered === 'no tiene' ||
    lowered === 'no tiene.'
  ) {
    return null;
  }

  return raw;
};

const parseFlexibleDate = (value) => {
  const raw = normalizeText(value);
  if (!raw) return null;

  const ddmmyyyy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    return `${year}-${month}-${day}`;
  }

  const yyyymmdd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyymmdd) {
    return raw;
  }

  return null;
};

const normalizeIntakeOrigin = (value) => {
  const raw = normalizeText(value);
  if (!raw) return 'purchase';

  const lowered = raw.toLowerCase();
  if (lowered === 'project_return' || lowered === 'return' || lowered === 'project') {
    return 'project_return';
  }

  return 'purchase';
};

const normalizeLifecycleStatus = (value) => {
  const raw = normalizeText(value);
  if (!raw) {
    return {
      assetStatus: null,
      lifecycleStatus: 'available',
    };
  }

  const lowered = raw.toLowerCase();
  if (lowered.includes('venta')) {
    return { assetStatus: raw, lifecycleStatus: 'sold' };
  }
  if (lowered.includes('eliminado') || lowered.includes('robado')) {
    return { assetStatus: raw, lifecycleStatus: 'retired' };
  }
  if (lowered.includes('malo')) {
    return { assetStatus: raw, lifecycleStatus: 'damaged' };
  }
  if (lowered.includes('por valorar')) {
    return { assetStatus: raw, lifecycleStatus: 'review' };
  }
  if (lowered.includes('incom')) {
    return { assetStatus: raw, lifecycleStatus: 'partial' };
  }
  if (lowered.includes('bueno')) {
    return { assetStatus: raw, lifecycleStatus: 'available' };
  }

  return { assetStatus: raw, lifecycleStatus: 'available' };
};

const normalizeForLookup = (value) => {
  return (value ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
};

const isFleetAssetLike = (asset) => {
  const category = normalizeForLookup(asset.categoryName ?? asset.category_name);
  const vehicleType = normalizeForLookup(asset.vehicleType ?? asset.vehicle_type);
  const assetName = normalizeForLookup(asset.assetName ?? asset.asset_name);
  const hasPlate = !!normalizeText(asset.vehiclePlate ?? asset.vehicle_plate);

  return hasPlate ||
    vehicleType.includes('veh') ||
    vehicleType.includes('flota') ||
    vehicleType.includes('maquinaria') ||
    category.includes('veh') ||
    category.includes('flota') ||
    category.includes('maquinaria') ||
    assetName.includes('camioneta') ||
    assetName.includes('vehiculo') ||
    assetName.includes('manlift') ||
    assetName.includes('bugui');
};

const parseIsoDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toDateOnly(value);
  }
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const toDateOnly = (value) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const buildFleetDocumentAlerts = (asset, referenceDate = new Date()) => {
  const current = toDateOnly(referenceDate);
  const checks = [
    { key: 'soat', label: 'SOAT', value: asset.soatDueDate ?? asset.soat_due_date },
    { key: 'insurance', label: 'seguro', value: asset.insuranceDueDate ?? asset.insurance_due_date },
    { key: 'technical', label: 'tecnomecánica', value: asset.technicalDueDate ?? asset.technical_due_date },
  ];

  return checks.map((item) => {
    const parsed = parseIsoDate(item.value);
    return {
      ...item,
      parsed,
      missing: !parsed,
      expired: !!parsed && parsed < current,
    };
  });
};

const normalizeWarehouseAssetPayload = (payload) => {
  const assetCode = normalizeText(payload.asset_code)?.toUpperCase() ?? null;
  const skuCode = normalizeText(payload.sku_code)?.toUpperCase() ?? null;
  const legacyItemCode = normalizeText(payload.legacy_item_code);
  const assetName = normalizeText(payload.asset_name);
  const categoryName = normalizeText(payload.category_name);
  const unitMeasure = normalizeText(payload.unit_measure);
  const brand = normalizeText(payload.brand);
  const serialNumber = normalizeText(payload.serial_number);
  const model = normalizeText(payload.model);
  const certificationNote = normalizeText(payload.certification_note);
  const eventDate = parseFlexibleDate(payload.event_date);
  const workOrder = normalizeText(payload.work_order);
  const clientName = normalizeText(payload.client_name);
  const dispatchNote = normalizeText(payload.dispatch_note);
  const auditDate = parseFlexibleDate(payload.audit_date);
  const currentCity = normalizeText(payload.current_city);
  const minimumStock = Number.isFinite(Number(payload.minimum_stock)) ? Number(payload.minimum_stock) : null;
  const currentStock = Number.isFinite(Number(payload.current_stock)) ? Number(payload.current_stock) : null;
  const vehiclePlate = normalizeText(payload.vehicle_plate);
  const vehicleType = normalizeText(payload.vehicle_type);
  const insuranceDueDate = parseFlexibleDate(payload.insurance_due_date);
  const soatDueDate = parseFlexibleDate(payload.soat_due_date);
  const technicalDueDate = parseFlexibleDate(payload.technical_due_date);
  const technicalDetail = normalizeText(payload.technical_detail);
  const intakeOrigin = normalizeIntakeOrigin(payload.intake_origin ?? payload.entry_origin);
  const intakeOriginProjectId = Number.isFinite(Number(payload.intake_origin_project_id))
    ? Number(payload.intake_origin_project_id)
    : (Number.isFinite(Number(payload.project_id)) ? Number(payload.project_id) : null);
  const notes = normalizeText(payload.notes);
  const status = normalizeLifecycleStatus(payload.asset_status);

  return {
    assetCode,
    skuCode,
    legacyItemCode,
    assetName,
    categoryName,
    unitMeasure,
    brand,
    serialNumber,
    model,
    certificationNote,
    eventDate,
    workOrder,
    clientName,
    dispatchNote,
    assetStatus: status.assetStatus,
    lifecycleStatus: status.lifecycleStatus,
    auditDate,
    currentCity,
    minimumStock,
    currentStock,
    vehiclePlate,
    vehicleType,
    insuranceDueDate,
    soatDueDate,
    technicalDueDate,
    technicalDetail,
    intakeOrigin,
    intakeOriginProjectId,
    notes,
  };
};

const generateNextAssetCode = async (connection) => {
  const [rows] = await connection.execute('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM warehouse_assets');
  const nextId = Number(rows[0]?.next_id || 1);
  return `WA${String(nextId).padStart(5, '0')}`;
};

const shouldImportWarehouseAsset = (asset) => {
  if (!asset.assetCode || !asset.assetName) return false;

  const loweredName = asset.assetName.toLowerCase();
  if (loweredName === 'bogota' || loweredName === 'espacio libre' || loweredName === 'item') {
    return false;
  }

  return true;
};

const addColumnIfMissing = async (connection, tableName, columnName, columnDefinition) => {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  if (Number(rows[0]?.total || 0) === 0) {
    await connection.execute(
      `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`,
    );
  }
};

const ensureWarehouseShape = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS warehouse_assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_code VARCHAR(60) NOT NULL,
      sku_code VARCHAR(80) NULL,
      legacy_item_code VARCHAR(80) NULL,
      asset_name VARCHAR(255) NOT NULL,
      category_name VARCHAR(120) NULL,
      unit_measure VARCHAR(60) NULL,
      brand VARCHAR(120) NULL,
      serial_number VARCHAR(160) NULL,
      model VARCHAR(160) NULL,
      certification_note TEXT NULL,
      event_date DATE NULL,
      work_order VARCHAR(160) NULL,
      client_name VARCHAR(255) NULL,
      dispatch_note VARCHAR(160) NULL,
      asset_status VARCHAR(120) NULL,
      lifecycle_status VARCHAR(50) NOT NULL DEFAULT 'available',
      audit_date DATE NULL,
      current_city VARCHAR(120) NULL,
      minimum_stock DECIMAL(12,2) NULL,
      current_stock DECIMAL(12,2) NULL,
      vehicle_plate VARCHAR(40) NULL,
      vehicle_type VARCHAR(120) NULL,
      insurance_due_date DATE NULL,
      soat_due_date DATE NULL,
      technical_due_date DATE NULL,
      technical_detail TEXT NULL,
      intake_origin VARCHAR(40) NOT NULL DEFAULT 'purchase',
      intake_origin_project_id INT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_asset_code (asset_code),
      INDEX idx_lifecycle_status (lifecycle_status),
      INDEX idx_current_city (current_city),
      INDEX idx_work_order (work_order)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS warehouse_asset_movements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_id INT NOT NULL,
      project_id INT NULL,
      movement_type VARCHAR(60) NOT NULL,
      movement_date DATE NULL,
      work_order VARCHAR(160) NULL,
      client_name VARCHAR(255) NULL,
      dispatch_note VARCHAR(160) NULL,
      evidence_path VARCHAR(500) NULL,
      quantity DECIMAL(12,2) NULL,
      serial_snapshot VARCHAR(160) NULL,
      delivery_signature_name VARCHAR(160) NULL,
      delivery_signature_data LONGTEXT NULL,
      receiving_signature_name VARCHAR(160) NULL,
      receiving_signature_data LONGTEXT NULL,
      vehicle_plate_snapshot VARCHAR(40) NULL,
      odometer_snapshot VARCHAR(80) NULL,
      fuel_level_snapshot VARCHAR(80) NULL,
      checklist_snapshot TEXT NULL,
      intake_origin VARCHAR(40) NOT NULL DEFAULT 'purchase',
      intake_origin_project_id INT NULL,
      status_snapshot VARCHAR(120) NULL,
      city_snapshot VARCHAR(120) NULL,
      responsible_user_id INT NULL,
      receiver_user_id INT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_asset_id (asset_id),
      INDEX idx_project_id (project_id),
      INDEX idx_movement_type (movement_type),
      INDEX idx_movement_date (movement_date)
    )
  `);

  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'evidence_path', 'VARCHAR(500) NULL AFTER dispatch_note');

  await addColumnIfMissing(connection, 'warehouse_assets', 'sku_code', 'VARCHAR(80) NULL AFTER asset_code');
  await addColumnIfMissing(connection, 'warehouse_assets', 'category_name', 'VARCHAR(120) NULL AFTER asset_name');
  await addColumnIfMissing(connection, 'warehouse_assets', 'unit_measure', 'VARCHAR(60) NULL AFTER category_name');
  await addColumnIfMissing(connection, 'warehouse_assets', 'minimum_stock', 'DECIMAL(12,2) NULL AFTER current_city');
  await addColumnIfMissing(connection, 'warehouse_assets', 'current_stock', 'DECIMAL(12,2) NULL AFTER minimum_stock');
  await addColumnIfMissing(connection, 'warehouse_assets', 'vehicle_plate', 'VARCHAR(40) NULL AFTER current_stock');
  await addColumnIfMissing(connection, 'warehouse_assets', 'vehicle_type', 'VARCHAR(120) NULL AFTER vehicle_plate');
  await addColumnIfMissing(connection, 'warehouse_assets', 'insurance_due_date', 'DATE NULL AFTER vehicle_type');
  await addColumnIfMissing(connection, 'warehouse_assets', 'soat_due_date', 'DATE NULL AFTER insurance_due_date');
  await addColumnIfMissing(connection, 'warehouse_assets', 'technical_due_date', 'DATE NULL AFTER soat_due_date');
  await addColumnIfMissing(connection, 'warehouse_assets', 'intake_origin', "VARCHAR(40) NOT NULL DEFAULT 'purchase' AFTER technical_detail");
  await addColumnIfMissing(connection, 'warehouse_assets', 'intake_origin_project_id', 'INT NULL AFTER intake_origin');

  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'quantity', 'DECIMAL(12,2) NULL AFTER evidence_path');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'serial_snapshot', 'VARCHAR(160) NULL AFTER quantity');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'delivery_signature_name', 'VARCHAR(160) NULL AFTER serial_snapshot');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'delivery_signature_data', 'LONGTEXT NULL AFTER delivery_signature_name');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'receiving_signature_name', 'VARCHAR(160) NULL AFTER delivery_signature_name');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'receiving_signature_data', 'LONGTEXT NULL AFTER receiving_signature_name');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'vehicle_plate_snapshot', 'VARCHAR(40) NULL AFTER receiving_signature_name');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'odometer_snapshot', 'VARCHAR(80) NULL AFTER vehicle_plate_snapshot');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'fuel_level_snapshot', 'VARCHAR(80) NULL AFTER odometer_snapshot');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'checklist_snapshot', 'TEXT NULL AFTER fuel_level_snapshot');
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'intake_origin', "VARCHAR(40) NOT NULL DEFAULT 'purchase' AFTER checklist_snapshot");
  await addColumnIfMissing(connection, 'warehouse_asset_movements', 'intake_origin_project_id', 'INT NULL AFTER intake_origin');
};

const upsertWarehouseAsset = async (connection, asset) => {
  await connection.execute(
    `INSERT INTO warehouse_assets (
       asset_code,
       sku_code,
       legacy_item_code,
       asset_name,
       category_name,
       unit_measure,
       brand,
       serial_number,
       model,
       certification_note,
       event_date,
       work_order,
       client_name,
       dispatch_note,
       asset_status,
       lifecycle_status,
       audit_date,
       current_city,
       minimum_stock,
       current_stock,
       vehicle_plate,
       vehicle_type,
       insurance_due_date,
       soat_due_date,
       technical_due_date,
       technical_detail,
       intake_origin,
       intake_origin_project_id,
       notes,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       sku_code = VALUES(sku_code),
       legacy_item_code = VALUES(legacy_item_code),
       asset_name = VALUES(asset_name),
       category_name = VALUES(category_name),
       unit_measure = VALUES(unit_measure),
       brand = VALUES(brand),
       serial_number = VALUES(serial_number),
       model = VALUES(model),
       certification_note = VALUES(certification_note),
       event_date = VALUES(event_date),
       work_order = VALUES(work_order),
       client_name = VALUES(client_name),
       dispatch_note = VALUES(dispatch_note),
       asset_status = VALUES(asset_status),
       lifecycle_status = VALUES(lifecycle_status),
       audit_date = VALUES(audit_date),
       current_city = VALUES(current_city),
       minimum_stock = VALUES(minimum_stock),
       current_stock = VALUES(current_stock),
       vehicle_plate = VALUES(vehicle_plate),
       vehicle_type = VALUES(vehicle_type),
       insurance_due_date = VALUES(insurance_due_date),
       soat_due_date = VALUES(soat_due_date),
       technical_due_date = VALUES(technical_due_date),
       technical_detail = VALUES(technical_detail),
      intake_origin = VALUES(intake_origin),
      intake_origin_project_id = VALUES(intake_origin_project_id),
       notes = VALUES(notes),
       updated_at = NOW()`,
    [
      asset.assetCode,
      asset.skuCode,
      asset.legacyItemCode,
      asset.assetName,
      asset.categoryName,
      asset.unitMeasure,
      asset.brand,
      asset.serialNumber,
      asset.model,
      asset.certificationNote,
      asset.eventDate,
      asset.workOrder,
      asset.clientName,
      asset.dispatchNote,
      asset.assetStatus,
      asset.lifecycleStatus,
      asset.auditDate,
      asset.currentCity,
      asset.minimumStock,
      asset.currentStock,
      asset.vehiclePlate,
      asset.vehicleType,
      asset.insuranceDueDate,
      asset.soatDueDate,
      asset.technicalDueDate,
      asset.technicalDetail,
      asset.intakeOrigin,
      asset.intakeOriginProjectId,
      asset.notes,
    ]
  );
};

module.exports = {
  ensureWarehouseShape,
  generateNextAssetCode,
  isFleetAssetLike,
  buildFleetDocumentAlerts,
  normalizeText,
  normalizeIntakeOrigin,
  parseFlexibleDate,
  normalizeWarehouseAssetPayload,
  shouldImportWarehouseAsset,
  upsertWarehouseAsset,
};