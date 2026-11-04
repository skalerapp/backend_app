const { HttpError } = require('../../utils/httpError');
const {
  applyMovementStockAdjustment,
  isFleetAssetLike,
} = require('./warehouse.service');

const OUTBOUND_TYPES = new Set(['delivery', 'assignment']);

const ensureDeliveryNotesSchema = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS warehouse_delivery_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      remision_number VARCHAR(40) NOT NULL,
      number_mode VARCHAR(16) NOT NULL DEFAULT 'auto',
      project_id INT NOT NULL,
      project_ot_code VARCHAR(80) NULL,
      project_name VARCHAR(255) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'issued',
      movement_date DATE NULL,
      movement_type VARCHAR(60) NOT NULL DEFAULT 'delivery',
      dispatcher_user_id INT NULL,
      dispatcher_name VARCHAR(160) NULL,
      transporter_type VARCHAR(24) NOT NULL DEFAULT 'internal',
      transporter_user_id INT NULL,
      transporter_name VARCHAR(160) NULL,
      transporter_company VARCHAR(160) NULL,
      site_receiver_name VARCHAR(160) NULL,
      site_receiver_user_id INT NULL,
      delivery_signature_name VARCHAR(160) NULL,
      receiving_signature_name VARCHAR(160) NULL,
      receiving_signature_data LONGTEXT NULL,
      evidence_path VARCHAR(500) NULL,
      physical_remision_path VARCHAR(500) NULL,
      dispatch_note VARCHAR(255) NULL,
      notes TEXT NULL,
      cancel_reason TEXT NULL,
      delivered_at DATETIME NULL,
      cancelled_at DATETIME NULL,
      created_by_user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_remision_number (remision_number),
      INDEX idx_delivery_note_project (project_id),
      INDEX idx_delivery_note_status (status),
      INDEX idx_delivery_note_date (movement_date)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS warehouse_delivery_note_lines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      delivery_note_id INT NOT NULL,
      movement_id INT NULL,
      asset_id INT NOT NULL,
      asset_code VARCHAR(60) NULL,
      asset_name VARCHAR(255) NULL,
      sku_code VARCHAR(80) NULL,
      unit_measure VARCHAR(60) NULL,
      quantity DECIMAL(12,2) NOT NULL,
      serial_snapshot VARCHAR(160) NULL,
      line_status VARCHAR(24) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dnl_note (delivery_note_id),
      INDEX idx_dnl_asset (asset_id),
      CONSTRAINT fk_dnl_note FOREIGN KEY (delivery_note_id) REFERENCES warehouse_delivery_notes (id) ON DELETE CASCADE
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS warehouse_delivery_note_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      delivery_note_id INT NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      reason TEXT NULL,
      user_id INT NULL,
      user_name VARCHAR(160) NULL,
      payload JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dne_note (delivery_note_id),
      CONSTRAINT fk_dne_note FOREIGN KEY (delivery_note_id) REFERENCES warehouse_delivery_notes (id) ON DELETE CASCADE
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS counters (
      name VARCHAR(64) NOT NULL PRIMARY KEY,
      value INT NOT NULL DEFAULT 0
    )
  `);

  await connection.execute(`
    INSERT INTO counters (name, value)
    SELECT 'warehouse_remision', 0
    WHERE NOT EXISTS (SELECT 1 FROM counters WHERE name = 'warehouse_remision')
  `);

  const [movementCols] = await connection.execute(
    `SELECT COUNT(*) AS total FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'warehouse_asset_movements' AND column_name = 'delivery_note_id'`,
  );
  if (Number(movementCols[0]?.total || 0) === 0) {
    await connection.execute(
      'ALTER TABLE warehouse_asset_movements ADD COLUMN delivery_note_id INT NULL AFTER project_id',
    );
    await connection.execute(
      'ALTER TABLE warehouse_asset_movements ADD INDEX idx_wm_delivery_note (delivery_note_id)',
    );
  }

  const [physicalCol] = await connection.execute(
    `SELECT COUNT(*) AS total FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'warehouse_delivery_notes' AND column_name = 'physical_remision_path'`,
  );
  if (Number(physicalCol[0]?.total || 0) === 0) {
    await connection.execute(
      'ALTER TABLE warehouse_delivery_notes ADD COLUMN physical_remision_path VARCHAR(500) NULL AFTER evidence_path',
    );
  }
};

const isActiveProjectStatus = (status) => {
  const normalized = normalizeText(status).toLowerCase();
  return normalized === 'active' || normalized === 'activo';
};

const normalizeText = (value) => (value ?? '').toString().trim();

const formatRemisionNumber = (value) => `REM-${String(value).padStart(6, '0')}`;

const reserveRemisionNumber = async (connection, { useAutoNumber, manualNumber }) => {
  const manual = normalizeText(manualNumber);
  if (!useAutoNumber) {
    if (!manual) {
      throw new HttpError(400, 'Debes indicar el número de remisión o usar consecutivo automático');
    }
    const [existing] = await connection.execute(
      'SELECT id FROM warehouse_delivery_notes WHERE remision_number = ? LIMIT 1',
      [manual],
    );
    if (existing.length) {
      throw new HttpError(409, `Ya existe una remisión con el número ${manual}`);
    }
    return { remisionNumber: manual, numberMode: 'manual' };
  }

  const [counterRows] = await connection.execute(
    "SELECT value FROM counters WHERE name = 'warehouse_remision' FOR UPDATE",
  );
  let next = Number(counterRows[0]?.value || 0) + 1;
  if (!counterRows.length) {
    await connection.execute("INSERT INTO counters (name, value) VALUES ('warehouse_remision', ?)", [next]);
  } else {
    await connection.execute("UPDATE counters SET value = ? WHERE name = 'warehouse_remision'", [next]);
  }

  let remisionNumber = formatRemisionNumber(next);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [existing] = await connection.execute(
      'SELECT id FROM warehouse_delivery_notes WHERE remision_number = ? LIMIT 1',
      [remisionNumber],
    );
    if (!existing.length) {
      return { remisionNumber, numberMode: 'auto' };
    }
    next += 1;
    await connection.execute("UPDATE counters SET value = ? WHERE name = 'warehouse_remision'", [next]);
    remisionNumber = formatRemisionNumber(next);
  }

  throw new HttpError(500, 'No fue posible generar un consecutivo de remisión');
};

const logDeliveryNoteEvent = async (connection, {
  deliveryNoteId,
  eventType,
  reason,
  userId,
  userName,
  payload,
}) => {
  await connection.execute(
    `INSERT INTO warehouse_delivery_note_events
      (delivery_note_id, event_type, reason, user_id, user_name, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      deliveryNoteId,
      eventType,
      reason || null,
      userId || null,
      userName || null,
      payload ? JSON.stringify(payload) : null,
    ],
  );
};

const loadProjectSnapshot = async (connection, projectId) => {
  const [rows] = await connection.execute(
    'SELECT id, name, ot_code, status FROM projects WHERE id = ? LIMIT 1',
    [projectId],
  );
  if (!rows.length) {
    throw new HttpError(404, 'Proyecto no encontrado');
  }
  if (!isActiveProjectStatus(rows[0].status)) {
    throw new HttpError(400, 'Solo puedes despachar a proyectos activos');
  }
  return rows[0];
};

const loadAssetRow = async (connection, assetId) => {
  const [rows] = await connection.execute(
    `SELECT id, asset_code, asset_name, sku_code, unit_measure, category_name, current_stock,
            vehicle_plate, vehicle_type, insurance_due_date, soat_due_date, technical_due_date
     FROM warehouse_assets WHERE id = ? LIMIT 1`,
    [assetId],
  );
  if (!rows.length) {
    throw new HttpError(404, `Activo ${assetId} no encontrado`);
  }
  return rows[0];
};

const insertLinkedMovement = async (connection, {
  deliveryNoteId,
  asset,
  projectId,
  movementType,
  movementDate,
  projectOtCode,
  projectName,
  quantity,
  serialSnapshot,
  header,
  sessionUserId,
  sessionUserName,
}) => {
  const delivererTypes = new Set(['delivery', 'assignment']);
  const resolvedDeliverySignatureName = delivererTypes.has(movementType)
    ? sessionUserName || header.dispatcher_name || null
    : header.delivery_signature_name || null;

  const [result] = await connection.execute(
    `INSERT INTO warehouse_asset_movements (
       asset_id, delivery_note_id, project_id, movement_type, movement_date,
       work_order, client_name, dispatch_note, evidence_path, quantity, serial_snapshot,
       delivery_signature_name, delivery_signature_data,
       receiving_signature_name, receiving_signature_data,
       responsible_user_id, receiver_user_id, notes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      asset.id,
      deliveryNoteId,
      projectId,
      movementType,
      movementDate || null,
      projectOtCode || null,
      projectName || null,
      header.dispatch_note || null,
      header.evidence_path || null,
      quantity,
      serialSnapshot || null,
      resolvedDeliverySignatureName,
      header.receiving_signature_name || null,
      header.receiving_signature_data || null,
      header.dispatcher_user_id || sessionUserId || null,
      header.site_receiver_user_id || null,
      header.notes || null,
    ],
  );

  await applyMovementStockAdjustment(connection, {
    asset,
    movementType,
    quantity,
  });

  return result.insertId;
};

const mapNoteRow = (row) => ({
  ...row,
  line_count: Number(row.line_count || 0),
});

const fetchDeliveryNoteById = async (connection, noteId) => {
  const [notes] = await connection.execute(
    `SELECT dn.*,
            (SELECT COUNT(*) FROM warehouse_delivery_note_lines l
             WHERE l.delivery_note_id = dn.id AND l.line_status = 'active') AS line_count
     FROM warehouse_delivery_notes dn
     WHERE dn.id = ?
     LIMIT 1`,
    [noteId],
  );
  if (!notes.length) {
    return null;
  }

  const note = notes[0];
  const [lines] = await connection.execute(
    `SELECT * FROM warehouse_delivery_note_lines
     WHERE delivery_note_id = ?
     ORDER BY id ASC`,
    [noteId],
  );
  const [events] = await connection.execute(
    `SELECT * FROM warehouse_delivery_note_events
     WHERE delivery_note_id = ?
     ORDER BY id DESC`,
    [noteId],
  );

  return {
    ...mapNoteRow(note),
    lines,
    events,
  };
};

const listDeliveryNotes = async (connection, { projectId, status, limit }) => {
  const conditions = [];
  const params = [];
  if (projectId) {
    conditions.push('dn.project_id = ?');
    params.push(Number(projectId));
  }
  if (status) {
    conditions.push('dn.status = ?');
    params.push(normalizeText(status));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);

  const [rows] = await connection.execute(
    `SELECT dn.*,
            (SELECT COUNT(*) FROM warehouse_delivery_note_lines l
             WHERE l.delivery_note_id = dn.id AND l.line_status = 'active') AS line_count
     FROM warehouse_delivery_notes dn
     ${where}
     ORDER BY dn.id DESC
     LIMIT ${normalizedLimit}`,
    params,
  );

  return rows.map(mapNoteRow);
};

const assertNoteEditable = (note, { requireReason }) => {
  if (note.status === 'cancelled') {
    throw new HttpError(409, 'La remisión está cancelada y no admite cambios');
  }
  if (requireReason && note.status === 'delivered') {
    return true;
  }
  return note.status !== 'cancelled';
};

const createDeliveryNote = async (connection, req, body) => {
  const projectId = Number(body.project_id || 0);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new HttpError(400, 'project_id es requerido');
  }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) {
    throw new HttpError(400, 'Debes incluir al menos un producto en la remisión');
  }

  const movementType = normalizeText(body.movement_type || 'delivery').toLowerCase() || 'delivery';
  if (!OUTBOUND_TYPES.has(movementType)) {
    throw new HttpError(400, 'movement_type debe ser delivery o assignment');
  }

  const transporterName = normalizeText(body.transporter_name);
  const siteReceiverName = normalizeText(body.site_receiver_name) || 'Recepción pendiente en obra';
  const sessionUserName = normalizeText(req.user?.name);
  const dispatcherName = sessionUserName || normalizeText(body.dispatcher_name);

  if (!dispatcherName) {
    throw new HttpError(400, 'No se pudo identificar al usuario de sesión que despacha');
  }
  if (!transporterName) {
    throw new HttpError(400, 'Debes indicar quién transporta el material');
  }

  const project = await loadProjectSnapshot(connection, projectId);
  const sessionUserId = Number(req.user?.id || 0);

  const { remisionNumber, numberMode } = await reserveRemisionNumber(connection, {
    useAutoNumber: body.use_auto_remision_number !== false && !normalizeText(body.remision_number),
    manualNumber: body.remision_number,
  });

  const header = {
    dispatch_note: normalizeText(body.dispatch_note) || null,
    evidence_path: normalizeText(body.evidence_path) || null,
    physical_remision_path: normalizeText(body.physical_remision_path) || null,
    notes: normalizeText(body.notes) || null,
    dispatcher_name: dispatcherName,
    dispatcher_user_id: sessionUserId || Number(body.dispatcher_user_id) || null,
    receiving_signature_name: normalizeText(body.receiving_signature_name) || null,
    receiving_signature_data: body.receiving_signature_data || null,
    site_receiver_user_id: Number(body.site_receiver_user_id) || null,
  };

  const [insertNote] = await connection.execute(
    `INSERT INTO warehouse_delivery_notes (
       remision_number, number_mode, project_id, project_ot_code, project_name,
       status, movement_date, movement_type,
       dispatcher_user_id, dispatcher_name,
       transporter_type, transporter_user_id, transporter_name, transporter_company,
       site_receiver_name, site_receiver_user_id,
       delivery_signature_name, receiving_signature_name, receiving_signature_data,
       evidence_path, physical_remision_path, dispatch_note, notes, created_by_user_id
     ) VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      remisionNumber,
      numberMode,
      projectId,
      project.ot_code || null,
      project.name || null,
      body.movement_date || null,
      movementType,
      header.dispatcher_user_id,
      dispatcherName,
      normalizeText(body.transporter_type || 'internal') || 'internal',
      Number(body.transporter_user_id) || null,
      transporterName,
      normalizeText(body.transporter_company) || null,
      siteReceiverName,
      header.site_receiver_user_id,
      dispatcherName,
      header.receiving_signature_name,
      header.receiving_signature_data,
      header.evidence_path,
      header.physical_remision_path,
      header.dispatch_note,
      header.notes,
      sessionUserId || null,
    ],
  );

  const deliveryNoteId = insertNote.insertId;
  const seenAssets = new Set();

  for (const rawLine of lines) {
    const assetId = Number(rawLine.asset_id || 0);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      throw new HttpError(400, 'Cada línea debe incluir asset_id');
    }
    if (seenAssets.has(assetId)) {
      throw new HttpError(400, 'No repitas el mismo producto en la remisión');
    }
    seenAssets.add(assetId);

    const asset = await loadAssetRow(connection, assetId);
    if (isFleetAssetLike(asset)) {
      throw new HttpError(409, 'Los vehículos se registran en Control de Flota, no en remisiones de materiales');
    }

    const qty = Number(rawLine.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpError(400, `Cantidad inválida para ${asset.asset_name || asset.asset_code}`);
    }

    const movementId = await insertLinkedMovement(connection, {
      deliveryNoteId,
      asset,
      projectId,
      movementType,
      movementDate: body.movement_date || null,
      projectOtCode: project.ot_code,
      projectName: project.name,
      quantity: qty,
      serialSnapshot: normalizeText(rawLine.serial_snapshot) || null,
      header,
      sessionUserId,
      sessionUserName,
    });

    await connection.execute(
      `INSERT INTO warehouse_delivery_note_lines (
         delivery_note_id, movement_id, asset_id, asset_code, asset_name, sku_code, unit_measure,
         quantity, serial_snapshot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deliveryNoteId,
        movementId,
        asset.id,
        asset.asset_code,
        asset.asset_name,
        asset.sku_code,
        asset.unit_measure,
        qty,
        normalizeText(rawLine.serial_snapshot) || null,
      ],
    );
  }

  await logDeliveryNoteEvent(connection, {
    deliveryNoteId,
    eventType: 'created',
    userId: sessionUserId,
    userName: sessionUserName,
    payload: { remision_number: remisionNumber, line_count: lines.length },
  });

  return fetchDeliveryNoteById(connection, deliveryNoteId);
};

const updateDeliveryNote = async (connection, req, noteId, body) => {
  const note = await fetchDeliveryNoteById(connection, noteId);
  if (!note) {
    throw new HttpError(404, 'Remisión no encontrada');
  }
  assertNoteEditable(note);

  const reason = normalizeText(body.reason);
  if (note.status === 'delivered' && !reason) {
    throw new HttpError(400, 'Debes indicar el motivo de la edición en una remisión entregada');
  }

  const updates = [];
  const params = [];

  const patchFields = [
    ['dispatcher_name', body.dispatcher_name],
    ['transporter_type', body.transporter_type],
    ['transporter_name', body.transporter_name],
    ['transporter_company', body.transporter_company],
    ['site_receiver_name', body.site_receiver_name],
    ['dispatch_note', body.dispatch_note],
    ['notes', body.notes],
    ['physical_remision_path', body.physical_remision_path],
  ];

  for (const [column, value] of patchFields) {
    if (value !== undefined) {
      updates.push(`${column} = ?`);
      params.push(normalizeText(value) || null);
    }
  }

  if (body.transporter_user_id !== undefined) {
    updates.push('transporter_user_id = ?');
    params.push(Number(body.transporter_user_id) || null);
  }
  if (body.site_receiver_user_id !== undefined) {
    updates.push('site_receiver_user_id = ?');
    params.push(Number(body.site_receiver_user_id) || null);
  }

  if (!updates.length) {
    throw new HttpError(400, 'No hay campos para actualizar');
  }

  params.push(noteId);
  await connection.execute(
    `UPDATE warehouse_delivery_notes SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
    params,
  );

  await logDeliveryNoteEvent(connection, {
    deliveryNoteId: noteId,
    eventType: 'updated',
    reason: reason || null,
    userId: Number(req.user?.id || 0) || null,
    userName: normalizeText(req.user?.name) || null,
    payload: body,
  });

  return fetchDeliveryNoteById(connection, noteId);
};

const addDeliveryNoteLine = async (connection, req, noteId, body) => {
  const note = await fetchDeliveryNoteById(connection, noteId);
  if (!note) {
    throw new HttpError(404, 'Remisión no encontrada');
  }
  assertNoteEditable(note);

  const reason = normalizeText(body.reason);
  if (note.status === 'delivered' && !reason) {
    throw new HttpError(400, 'Debes indicar por qué agregas producto a una remisión ya entregada');
  }

  const assetId = Number(body.asset_id || 0);
  const qty = Number(body.quantity);
  if (!Number.isFinite(assetId) || assetId <= 0 || !Number.isFinite(qty) || qty <= 0) {
    throw new HttpError(400, 'asset_id y quantity son requeridos');
  }

  const activeLine = note.lines.find((line) => line.line_status === 'active' && Number(line.asset_id) === assetId);
  if (activeLine) {
    throw new HttpError(409, 'Ese producto ya está en la remisión. Edita la cantidad con un ajuste futuro o agrega otro ítem.');
  }

  const asset = await loadAssetRow(connection, assetId);
  if (isFleetAssetLike(asset)) {
    throw new HttpError(409, 'Los vehículos no se agregan en remisiones de materiales');
  }

  const sessionUserId = Number(req.user?.id || 0);
  const sessionUserName = normalizeText(req.user?.name);

  const header = {
    dispatch_note: note.dispatch_note,
    evidence_path: note.evidence_path,
    notes: note.notes,
    dispatcher_name: note.dispatcher_name,
    dispatcher_user_id: note.dispatcher_user_id,
    receiving_signature_name: note.receiving_signature_name,
    receiving_signature_data: note.receiving_signature_data,
    site_receiver_user_id: note.site_receiver_user_id,
  };

  const movementId = await insertLinkedMovement(connection, {
    deliveryNoteId: noteId,
    asset,
    projectId: note.project_id,
    movementType: note.movement_type,
    movementDate: note.movement_date,
    projectOtCode: note.project_ot_code,
    projectName: note.project_name,
    quantity: qty,
    serialSnapshot: normalizeText(body.serial_snapshot) || null,
    header,
    sessionUserId,
    sessionUserName,
  });

  await connection.execute(
    `INSERT INTO warehouse_delivery_note_lines (
       delivery_note_id, movement_id, asset_id, asset_code, asset_name, sku_code, unit_measure,
       quantity, serial_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      noteId,
      movementId,
      asset.id,
      asset.asset_code,
      asset.asset_name,
      asset.sku_code,
      asset.unit_measure,
      qty,
      normalizeText(body.serial_snapshot) || null,
    ],
  );

  await logDeliveryNoteEvent(connection, {
    deliveryNoteId: noteId,
    eventType: 'line_added',
    reason: reason || null,
    userId: sessionUserId || null,
    userName: sessionUserName || null,
    payload: { asset_id: assetId, quantity: qty },
  });

  return fetchDeliveryNoteById(connection, noteId);
};

const markDeliveryNoteDelivered = async (connection, req, noteId) => {
  const note = await fetchDeliveryNoteById(connection, noteId);
  if (!note) {
    throw new HttpError(404, 'Remisión no encontrada');
  }
  if (note.status === 'cancelled') {
    throw new HttpError(409, 'La remisión está cancelada');
  }
  if (note.status === 'delivered') {
    return note;
  }

  await connection.execute(
    `UPDATE warehouse_delivery_notes SET status = 'delivered', delivered_at = NOW() WHERE id = ?`,
    [noteId],
  );

  await logDeliveryNoteEvent(connection, {
    deliveryNoteId: noteId,
    eventType: 'delivered',
    userId: Number(req.user?.id || 0) || null,
    userName: normalizeText(req.user?.name) || null,
  });

  return fetchDeliveryNoteById(connection, noteId);
};

const cancelDeliveryNote = async (connection, req, noteId, body) => {
  const reason = normalizeText(body.reason);
  if (!reason) {
    throw new HttpError(400, 'Debes indicar el motivo de cancelación de la remisión');
  }

  const note = await fetchDeliveryNoteById(connection, noteId);
  if (!note) {
    throw new HttpError(404, 'Remisión no encontrada');
  }
  if (note.status === 'cancelled') {
    throw new HttpError(409, 'La remisión ya está cancelada');
  }

  const sessionUserId = Number(req.user?.id || 0);
  const sessionUserName = normalizeText(req.user?.name);

  for (const line of note.lines) {
    if (line.line_status !== 'active' || !line.movement_id) {
      continue;
    }
    const asset = await loadAssetRow(connection, line.asset_id);
    await insertLinkedMovement(connection, {
      deliveryNoteId: noteId,
      asset,
      projectId: note.project_id,
      movementType: 'return',
      movementDate: note.movement_date,
      projectOtCode: note.project_ot_code,
      projectName: note.project_name,
      quantity: line.quantity,
      serialSnapshot: line.serial_snapshot,
      header: {
        dispatch_note: `Reversión remisión ${note.remision_number}`,
        evidence_path: null,
        notes: reason,
        dispatcher_name: note.dispatcher_name,
        dispatcher_user_id: note.dispatcher_user_id,
        receiving_signature_name: null,
        receiving_signature_data: null,
        site_receiver_user_id: note.site_receiver_user_id,
      },
      sessionUserId,
      sessionUserName,
    });

    await connection.execute(
      'UPDATE warehouse_delivery_note_lines SET line_status = ? WHERE id = ?',
      ['void', line.id],
    );
  }

  await connection.execute(
    `UPDATE warehouse_delivery_notes
     SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
     WHERE id = ?`,
    [reason, noteId],
  );

  await logDeliveryNoteEvent(connection, {
    deliveryNoteId: noteId,
    eventType: 'cancelled',
    reason,
    userId: sessionUserId || null,
    userName: sessionUserName || null,
  });

  return fetchDeliveryNoteById(connection, noteId);
};

module.exports = {
  ensureDeliveryNotesSchema,
  listDeliveryNotes,
  fetchDeliveryNoteById,
  createDeliveryNote,
  updateDeliveryNote,
  addDeliveryNoteLine,
  markDeliveryNoteDelivered,
  cancelDeliveryNote,
};
