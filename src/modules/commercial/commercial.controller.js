const db = require('../../config/database');
const { applyAuditContext } = require('../../utils/auditContext');
const { normalizeRole } = require('../../middleware/auth.middleware');
const {
  buildVisitOwnerFilter,
  buildQuotationOwnerFilter,
  buildOpportunityOwnerFilter,
  buildCommercialProjectVisibilityFilter,
  appendSqlFilter,
  pushFilter,
  ownsCommercialVisit,
  ownsCommercialQuotation,
  ownsCommercialOpportunity,
} = require('./commercialVisibility.service');

const pool = db.pool;

const ALLOWED_STATUSES = new Set(['planned', 'completed', 'follow_up', 'cancelled']);
const LEGACY_STATUS_MAP = {
  scheduled: 'planned',
};

const ALLOWED_OPPORTUNITY_STAGES = new Set([
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'on_hold',
]);

const OPPORTUNITY_STAGE_PROBABILITY = {
  lead: 15,
  qualified: 35,
  proposal: 60,
  negotiation: 80,
  won: 100,
  lost: 0,
  on_hold: 25,
};

const DEFAULT_COMMERCIAL_FORM_TEMPLATES = [
  {
    code: 'levantamiento',
    name: 'Levantamiento',
    description: 'Plantilla para diagnostico inicial, levantamiento tecnico y deteccion de oportunidad.',
    fields: [
      { key: 'interest_level', label: 'Nivel de interes', required: false },
      { key: 'estimated_value', label: 'Potencial estimado', required: false },
      { key: 'decision_window', label: 'Ventana de decision', required: false },
    ],
  },
  {
    code: 'seguimiento',
    name: 'Seguimiento',
    description: 'Plantilla para seguimiento comercial, validacion de avance y bloqueadores.',
    fields: [
      { key: 'pipeline_stage', label: 'Etapa del pipeline', required: false },
      { key: 'blockers', label: 'Bloqueadores', required: false },
      { key: 'conversion_probability', label: 'Probabilidad de cierre', required: false },
    ],
  },
  {
    code: 'cierre',
    name: 'Cierre comercial',
    description: 'Plantilla para resultado final, motivo de cierre o reactivacion comercial.',
    fields: [
      { key: 'closing_result', label: 'Resultado del cierre', required: false },
      { key: 'closure_reason', label: 'Motivo principal', required: false },
      { key: 'reactivation_window', label: 'Ventana de reactivacion', required: false },
    ],
  },
];

const INTERNAL_LOCATION_ROLES = new Set(['super_admin', 'administrative', 'gerencial']);

const canViewInternalLocation = (roleValue) => INTERNAL_LOCATION_ROLES.has(normalizeRole(roleValue));

const COMMERCIAL_VISIT_SELECT = `SELECT
  cv.id,
  cv.client_id,
  cv.client_name,
  cv.client_contact,
  cv.visit_date,
  cv.city,
  cv.service_scope,
  cv.site_conditions,
  cv.access_types,
  cv.delivery_time_estimate,
  cv.will_generate_quotation,
  cv.latitude,
  cv.longitude,
  cv.form_type,
  cv.form_payload,
  cv.summary,
  cv.outcome,
  cv.next_action,
  cv.next_action_date,
  cv.evidence_path,
  cv.expense_amount,
  cv.status,
  cv.project_id,
  cv.commercial_id,
  cv.created_by,
  cv.created_at,
  cv.updated_at,
  p.name AS project_name,
  u.name AS created_by_name,
  vl.lat AS audit_lat,
  vl.lng AS audit_lng,
  vl.recorded_at AS audit_recorded_at
FROM commercial_visits cv
LEFT JOIN projects p ON cv.project_id = p.id
LEFT JOIN users u ON cv.created_by = u.id
LEFT JOIN (
  SELECT vl1.visit_id, vl1.lat, vl1.lng, vl1.recorded_at
  FROM visit_locations vl1
  INNER JOIN (
    SELECT visit_id, MAX(id) AS max_id
    FROM visit_locations
    GROUP BY visit_id
  ) latest ON latest.max_id = vl1.id
) vl ON vl.visit_id = cv.id`;

const COMMERCIAL_OPPORTUNITY_SELECT = `SELECT
  co.id,
  co.client_id,
  co.client_name,
  co.contact_name,
  co.opportunity_name,
  co.stage,
  co.estimated_value,
  co.probability,
  co.expected_close_date,
  co.last_activity_date,
  co.next_step,
  co.notes,
  co.project_id,
  co.source_visit_id,
  co.owner_user_id,
  co.created_by,
  co.created_at,
  co.updated_at,
  p.name AS project_name,
  owner.name AS owner_name,
  creator.name AS created_by_name,
  cv.visit_date AS source_visit_date,
  cv.status AS source_visit_status
FROM commercial_opportunities co
LEFT JOIN projects p ON co.project_id = p.id
LEFT JOIN users owner ON co.owner_user_id = owner.id
LEFT JOIN users creator ON co.created_by = creator.id
LEFT JOIN commercial_visits cv ON co.source_visit_id = cv.id`;

const normalizeStatus = (value) => {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (!normalized) return 'planned';
  if (LEGACY_STATUS_MAP[normalized]) return LEGACY_STATUS_MAP[normalized];
  return ALLOWED_STATUSES.has(normalized) ? normalized : null;
};

const normalizeOpportunityStage = (value) => {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (!normalized) return 'lead';
  return ALLOWED_OPPORTUNITY_STAGES.has(normalized) ? normalized : null;
};

const parseOpportunityStageCandidate = (value) => {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (!normalized) return null;
  return ALLOWED_OPPORTUNITY_STAGES.has(normalized) ? normalized : null;
};

const normalizeNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeProbability = (value, stage = 'lead') => {
  if (value === null || value === undefined || value === '') {
    return OPPORTUNITY_STAGE_PROBABILITY[stage] ?? OPPORTUNITY_STAGE_PROBABILITY.lead;
  }
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 100) return null;
  return parsed;
};

const normalizeDate = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().substring(0, 10);
  }
  const text = value.toString().trim();
  if (!text) return null;
  return text.length >= 10 ? text.substring(0, 10) : text;
};

const parseFormPayload = (raw) => {
  if (raw === null || raw === undefined) return null;
  const text = raw.toString().trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
};

const serializeFormPayload = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch (_) {
      return JSON.stringify({ notes: trimmed });
    }
  }
  return JSON.stringify(value);
};

const normalizeTemplateField = (field, index) => {
  const normalizedKey = (field?.key || `field_${index + 1}`)
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_');

  return {
    key: normalizedKey,
    label: (field?.label || field?.key || `Campo ${index + 1}`).toString().trim(),
    required: !!field?.required,
  };
};

const normalizeTemplatePayload = (payload = {}) => {
  const code = (payload.code || payload.name || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_');

  const name = (payload.name || '').toString().trim();
  const description = payload.description == null ? null : payload.description.toString().trim();
  const fieldList = Array.isArray(payload.fields) ? payload.fields : [];
  const normalizedFields = fieldList
    .map((field, index) => normalizeTemplateField(field, index))
    .filter((field) => field.key && field.label);

  return {
    code,
    name,
    description: description || null,
    fields: normalizedFields,
    is_active: payload.is_active === undefined ? true : !!payload.is_active,
  };
};

const normalizeClientMatchKey = (value) => (value || '')
  .toString()
  .trim()
  .toLowerCase();

const resolveRegisteredCommercialClient = async (connection, clientId) => {
  const normalizedClientId = normalizeNumber(clientId);
  if (!normalizedClientId) {
    return {
      error: 'Debes seleccionar un cliente registrado. Crea el cliente antes de guardar la visita.',
    };
  }

  const [rows] = await connection.execute(
    'SELECT id, business_name, contact_name, city FROM commercial_clients WHERE id = ? LIMIT 1',
    [normalizedClientId],
  );

  if (!rows.length) {
    return {
      error: 'El cliente seleccionado no existe. Regístralo nuevamente en el directorio comercial.',
    };
  }

  return { client: rows[0] };
};

const extractPayloadNumber = (payload, keys = []) => {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of keys) {
    const parsed = normalizeNumber(payload[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
};

const containsAnyKeyword = (text, keywords = []) => {
  const normalized = (text || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) return false;
  return keywords.some((keyword) => normalized.includes(keyword));
};

const inferOpportunityStageFromVisit = ({ visit, payload = null, automation = {} }) => {
  const requestedStage = parseOpportunityStageCandidate(automation.stage);
  if (requestedStage) return requestedStage;

  const payloadStage = parseOpportunityStageCandidate(payload?.pipeline_stage || payload?.stage);
  if (payloadStage) return payloadStage;

  const signalText = [
    visit.outcome,
    visit.summary,
    visit.next_action,
    payload?.closing_result,
    payload?.closure_reason,
    payload?.blockers,
  ].filter(Boolean).join(' ');

  if (containsAnyKeyword(signalText, ['ganad', 'aprobad', 'adjudic', 'cierre exitos', 'cerrado'])) return 'won';
  if (containsAnyKeyword(signalText, ['perdid', 'rechaz', 'cancel', 'descart', 'sin interes'])) return 'lost';
  if (containsAnyKeyword(signalText, ['negoci', 'ajuste final', 'condicion comercial', 'cierre final'])) return 'negotiation';
  if (containsAnyKeyword(signalText, ['propuesta', 'cotizacion', 'oferta economica', 'radicar propuesta'])) return 'proposal';
  if (visit.status === 'follow_up' || containsAnyKeyword(signalText, ['seguimiento', 'decision', 'validacion', 'interes'])) return 'qualified';
  if (visit.status === 'completed') return 'lead';
  return 'lead';
};

const shouldUseAutomaticRules = (automation = {}) => {
  if (!automation || typeof automation !== 'object') return false;
  if (automation.mode === 'off') return false;
  return automation.mode === 'auto' || automation.apply_rules === true;
};

const detectVisitAutomationSignals = ({ visit, payload = null, automation = {} }) => {
  const inferredStage = inferOpportunityStageFromVisit({ visit, payload, automation });
  const estimatedValue = normalizeNumber(automation.estimated_value)
    ?? extractPayloadNumber(payload, ['estimated_value', 'potential_value', 'business_value'])
    ?? 0;

  const reasonCodes = [];
  if (visit.status === 'follow_up') reasonCodes.push('follow_up_status');
  if (visit.form_type === 'seguimiento') reasonCodes.push('follow_up_template');
  if (visit.form_type === 'cierre') reasonCodes.push('closing_template');
  if (estimatedValue > 0) reasonCodes.push('estimated_value');
  if (inferredStage !== 'lead') reasonCodes.push(`stage_${inferredStage}`);
  if (containsAnyKeyword(visit.outcome, ['propuesta', 'cotizacion', 'negoci', 'ganad', 'perdid'])) reasonCodes.push('outcome_signal');

  return {
    inferredStage,
    estimatedValue,
    eligible: reasonCodes.length > 0,
    reasonCodes,
  };
};

const buildVisitOpportunityDefaults = ({ visit, automation = {}, userId = null }) => {
  const payload = visit.form_payload && typeof visit.form_payload === 'object'
    ? visit.form_payload
    : parseFormPayload(visit.form_payload);
  const signals = detectVisitAutomationSignals({ visit, payload, automation });
  const selectedStage = signals.inferredStage;
  const estimatedValue = signals.estimatedValue;
  const probability = normalizeProbability(
    automation.probability ?? payload?.conversion_probability,
    selectedStage,
  );

  return {
    client_id: visit.client_id,
    client_name: visit.client_name,
    contact_name: automation.contact_name == null
      ? (visit.client_contact || null)
      : (automation.contact_name?.toString().trim() || null),
    opportunity_name: (automation.opportunity_name || automation.name || visit.summary || `Oportunidad ${visit.client_name}`)
      .toString()
      .trim(),
    stage: selectedStage,
    estimated_value: estimatedValue,
    probability,
    expected_close_date: normalizeDate(automation.expected_close_date) || visit.next_action_date || null,
    last_activity_date: visit.visit_date,
    next_step: (automation.next_step || visit.next_action || null)?.toString().trim() || null,
    notes: (automation.notes || visit.outcome || visit.summary || null)?.toString().trim() || null,
    project_id: normalizeNumber(automation.project_id) ?? visit.project_id ?? null,
    source_visit_id: visit.id,
    owner_user_id: normalizeNumber(automation.owner_user_id) ?? userId,
    automation_reason_codes: signals.reasonCodes,
  };
};

const upsertOpportunityFromVisit = async ({ connection, req, visit }) => {
  const automation = req.body?.automation;
  const isManualAutomation = !!automation?.create_opportunity;
  const payload = visit.form_payload && typeof visit.form_payload === 'object'
    ? visit.form_payload
    : parseFormPayload(visit.form_payload);
  const detectedSignals = detectVisitAutomationSignals({ visit, payload, automation });
  const automaticRulesEnabled = shouldUseAutomaticRules(automation);

  if (!isManualAutomation && !(automaticRulesEnabled && detectedSignals.eligible)) {
    return null;
  }

  const opportunityPayload = buildVisitOpportunityDefaults({
    visit,
    automation,
    userId: req.user?.id ?? null,
  });

  const [existingRows] = await connection.execute(
    'SELECT id FROM commercial_opportunities WHERE source_visit_id = ? LIMIT 1',
    [visit.id],
  );

  if (existingRows.length > 0) {
    const opportunityId = existingRows[0].id;
    await connection.execute(
      `UPDATE commercial_opportunities
       SET client_id = ?,
           client_name = ?,
           contact_name = ?,
           opportunity_name = ?,
           stage = ?,
           estimated_value = ?,
           probability = ?,
           expected_close_date = ?,
           last_activity_date = ?,
           next_step = ?,
           notes = ?,
           project_id = ?,
           owner_user_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        opportunityPayload.client_id,
        opportunityPayload.client_name,
        opportunityPayload.contact_name,
        opportunityPayload.opportunity_name,
        opportunityPayload.stage,
        opportunityPayload.estimated_value,
        opportunityPayload.probability,
        opportunityPayload.expected_close_date,
        opportunityPayload.last_activity_date,
        opportunityPayload.next_step,
        opportunityPayload.notes,
        opportunityPayload.project_id,
        opportunityPayload.owner_user_id,
        opportunityId,
      ],
    );

    const [rows] = await connection.execute(`${COMMERCIAL_OPPORTUNITY_SELECT} WHERE co.id = ?`, [opportunityId]);
    return {
      action: 'updated',
      mode: isManualAutomation ? 'manual' : 'auto',
      reasons: opportunityPayload.automation_reason_codes,
      opportunity: mapOpportunityRow(rows[0]),
    };
  }

  const [result] = await connection.execute(
    `INSERT INTO commercial_opportunities (
       client_id,
       client_name,
       contact_name,
       opportunity_name,
       stage,
       estimated_value,
       probability,
       expected_close_date,
       last_activity_date,
       next_step,
       notes,
       project_id,
       source_visit_id,
       owner_user_id,
       created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opportunityPayload.client_id,
      opportunityPayload.client_name,
      opportunityPayload.contact_name,
      opportunityPayload.opportunity_name,
      opportunityPayload.stage,
      opportunityPayload.estimated_value,
      opportunityPayload.probability,
      opportunityPayload.expected_close_date,
      opportunityPayload.last_activity_date,
      opportunityPayload.next_step,
      opportunityPayload.notes,
      opportunityPayload.project_id,
      opportunityPayload.source_visit_id,
      opportunityPayload.owner_user_id,
      req.user?.id ?? null,
    ],
  );

  const [rows] = await connection.execute(`${COMMERCIAL_OPPORTUNITY_SELECT} WHERE co.id = ?`, [result.insertId]);
  return {
    action: 'created',
    mode: isManualAutomation ? 'manual' : 'auto',
    reasons: opportunityPayload.automation_reason_codes,
    opportunity: mapOpportunityRow(rows[0]),
  };
};

const mapVisitRow = (row, req = null) => {
  const mapped = {
    ...row,
    visit_date: normalizeDate(row.visit_date),
    next_action_date: normalizeDate(row.next_action_date),
    form_payload: parseFormPayload(row.form_payload),
    will_generate_quotation: row.will_generate_quotation === undefined
      ? undefined
      : !!Number(row.will_generate_quotation),
  };

  const showInternalLocation = req ? canViewInternalLocation(req.user?.role) : false;
  if (showInternalLocation && row.audit_lat != null && row.audit_lng != null) {
    mapped.audit_location = {
      latitude: Number(row.audit_lat),
      longitude: Number(row.audit_lng),
      recorded_at: row.audit_recorded_at,
    };
  }

  delete mapped.audit_lat;
  delete mapped.audit_lng;
  delete mapped.audit_recorded_at;
  delete mapped.latitude;
  delete mapped.longitude;

  return mapped;
};

const mapOpportunityRow = (row) => ({
  ...row,
  expected_close_date: normalizeDate(row.expected_close_date),
  last_activity_date: normalizeDate(row.last_activity_date),
  source_visit_date: normalizeDate(row.source_visit_date),
});

const mapQuotationRow = (row) => ({
  ...row,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const listQuotations = async (req, res) => {
  let connection;
  try {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const visitId = req.query.visit_id ? Number(req.query.visit_id) : null;
    const searchQuery = req.query.query?.toString().trim();

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    let sql = `
      SELECT cq.*, ot.ot_code
      FROM commercial_quotations cq
      LEFT JOIN orders_ot ot ON ot.id = (
        SELECT MAX(id) FROM orders_ot WHERE quotation_id = cq.id
      )
    `;
    const conditions = [];
    const params = [];

    if (projectId != null) {
      conditions.push('cq.project_id = ?');
      params.push(projectId);
    }
    if (visitId != null) {
      conditions.push('cq.visit_id = ?');
      params.push(visitId);
    }
    if (searchQuery != null && searchQuery.length > 0) {
      conditions.push('cq.quotation_number LIKE ?');
      params.push(`%${searchQuery}%`);
    }

    pushFilter(conditions, params, buildQuotationOwnerFilter(req.user?.role, req.user?.id, 'cq'));

    if (conditions.length > 0) {
      sql += `WHERE ${conditions.join(' AND ')}\n`;
    }

    sql += 'ORDER BY cq.created_at DESC\nLIMIT 200';

    const [rows] = await connection.execute(sql, params);
    res.json({ success: true, data: rows.map(mapQuotationRow) });
  } catch (error) {
    console.error('listQuotations error:', error);
    res.status(500).json({ success: false, message: 'Error al listar cotizaciones', error: error.message });
  } finally {
    connection?.release();
  }
};

const getQuotationById = async (req, res) => {
  let connection;
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Id invalido' });
    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);
    const [rows] = await connection.execute(`
      SELECT cq.*, ot.ot_code
      FROM commercial_quotations cq
      LEFT JOIN orders_ot ot ON ot.id = (
        SELECT MAX(id) FROM orders_ot WHERE quotation_id = cq.id
      )
      WHERE cq.id = ?
      LIMIT 1
    `, [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    if (!ownsCommercialQuotation(rows[0], req.user?.role, req.user?.id)) {
      return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    }
    res.json({ success: true, data: mapQuotationRow(rows[0]) });
  } catch (error) {
    console.error('getQuotationById error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener cotización', error: error.message });
  } finally {
    connection?.release();
  }
};

const approveQuotation = async (req, res) => {
  let connection;
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Id invalido' });
    const payload = req.body || {};
    const approvedValue = payload.approved_value ? Number(payload.approved_value) : null;

    // permission: only gerencial/administrative/super_admin
    if (!canViewInternalLocation(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'No autorizado para aprobar cotizaciones' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);
    await connection.beginTransaction();

    const [rows] = await connection.execute('SELECT * FROM commercial_quotations WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    }
    const quotation = rows[0];
    if (quotation.status === 'aprobado') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Cotización ya aprobada' });
    }

    await connection.execute(
      'UPDATE commercial_quotations SET status = ?, approved_value = ?, approval_date = NOW(), updated_at = NOW() WHERE id = ?',
      ['aprobado', approvedValue, id]
    );

    // Optionally create OT row
    if (payload.create_ot) {
      const otCode = payload.ot_code || `OT-${id}-${Date.now()}`;
      const [otResult] = await connection.execute(
        'INSERT INTO orders_ot (ot_code, quotation_id, assigned_by, assigned_at) VALUES (?, ?, ?, NOW())',
        [otCode, id, req.user?.id ?? null]
      );
    }

    await applyAuditContext(connection, req);
    await connection.commit();

    const [updatedRows] = await connection.execute(`
      SELECT cq.*, ot.ot_code
      FROM commercial_quotations cq
      LEFT JOIN orders_ot ot ON ot.id = (
        SELECT MAX(id) FROM orders_ot WHERE quotation_id = cq.id
      )
      WHERE cq.id = ?
      LIMIT 1
    `, [id]);
    res.json({ success: true, message: 'Cotización aprobada', data: mapQuotationRow(updatedRows[0]) });
  } catch (error) {
    console.error('approveQuotation error:', error);
    try { await connection?.rollback(); } catch (_) {}
    res.status(500).json({ success: false, message: 'Error al aprobar cotización', error: error.message });
  } finally {
    connection?.release();
  }
};

const mapCommercialTemplateRow = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  fields: parseFormPayload(row.fields_json) ?? [],
  is_active: !!row.is_active,
  created_by: row.created_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const hasColumn = async (connection, tableName, columnName) => {
  const [rows] = await connection.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [columnName]);
  return rows.length > 0;
};

const ensureColumn = async (connection, tableName, columnName, definition) => {
  const exists = await hasColumn(connection, tableName, columnName);
  if (!exists) {
    await connection.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const ensureCommercialVisitsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS commercial_visits (
      id INT PRIMARY KEY AUTO_INCREMENT,
      client_name VARCHAR(160) NOT NULL,
      client_contact VARCHAR(160) NULL,
      visit_date DATE NOT NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      form_type VARCHAR(80) NULL,
      form_payload LONGTEXT NULL,
      summary TEXT NULL,
      outcome TEXT NULL,
      next_action TEXT NULL,
      next_action_date DATE NULL,
      evidence_path VARCHAR(500) NULL,
      expense_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      status ENUM('planned', 'completed', 'follow_up', 'cancelled') NOT NULL DEFAULT 'planned',
      project_id INT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_client_name (client_name),
      INDEX idx_visit_date (visit_date),
      INDEX idx_next_action_date (next_action_date),
      INDEX idx_status (status),
      INDEX idx_project_id (project_id)
    )
  `);

  if (await hasColumn(connection, 'commercial_visits', 'employee_id')) {
    try {
      await connection.execute('ALTER TABLE commercial_visits MODIFY COLUMN employee_id INT NULL');
    } catch (_) {}
  }

  await ensureColumn(connection, 'commercial_visits', 'client_contact', 'VARCHAR(160) NULL AFTER client_name');
  await ensureColumn(connection, 'commercial_visits', 'latitude', 'DECIMAL(10,7) NULL AFTER visit_date');
  await ensureColumn(connection, 'commercial_visits', 'longitude', 'DECIMAL(10,7) NULL AFTER latitude');
  await ensureColumn(connection, 'commercial_visits', 'form_type', 'VARCHAR(80) NULL AFTER longitude');
  await ensureColumn(connection, 'commercial_visits', 'form_payload', 'LONGTEXT NULL AFTER form_type');
  await ensureColumn(connection, 'commercial_visits', 'summary', 'TEXT NULL AFTER form_payload');
  await ensureColumn(connection, 'commercial_visits', 'outcome', 'TEXT NULL AFTER summary');
  await ensureColumn(connection, 'commercial_visits', 'next_action', 'TEXT NULL AFTER outcome');
  await ensureColumn(connection, 'commercial_visits', 'next_action_date', 'DATE NULL AFTER next_action');
  await ensureColumn(connection, 'commercial_visits', 'evidence_path', 'VARCHAR(500) NULL AFTER next_action_date');
  await ensureColumn(connection, 'commercial_visits', 'expense_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER evidence_path');
  await ensureColumn(connection, 'commercial_visits', 'project_id', 'INT NULL AFTER status');
  await ensureColumn(connection, 'commercial_visits', 'created_by', 'INT NULL AFTER project_id');
  await ensureColumn(connection, 'commercial_visits', 'updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
  await ensureColumn(connection, 'commercial_visits', 'client_id', 'INT NULL AFTER id');
  await ensureColumn(connection, 'commercial_visits', 'city', 'VARCHAR(120) NULL AFTER visit_date');
  await ensureColumn(connection, 'commercial_visits', 'service_scope', 'TEXT NULL AFTER city');
  await ensureColumn(connection, 'commercial_visits', 'site_conditions', 'TEXT NULL AFTER service_scope');
  await ensureColumn(connection, 'commercial_visits', 'access_types', 'VARCHAR(255) NULL AFTER site_conditions');
  await ensureColumn(connection, 'commercial_visits', 'delivery_time_estimate', 'VARCHAR(128) NULL AFTER access_types');
  await ensureColumn(connection, 'commercial_visits', 'will_generate_quotation', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER delivery_time_estimate');
  await ensureColumn(connection, 'commercial_visits', 'commercial_id', 'INT NULL AFTER will_generate_quotation');

  if (await hasColumn(connection, 'commercial_visits', 'client_phone')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET client_contact = COALESCE(NULLIF(client_contact, ''), NULLIF(client_phone, ''), client_contact)
      WHERE client_contact IS NULL OR client_contact = ''
    `);
  }

  if (await hasColumn(connection, 'commercial_visits', 'client_email')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET client_contact = COALESCE(NULLIF(client_contact, ''), NULLIF(client_email, ''), client_contact)
      WHERE client_contact IS NULL OR client_contact = ''
    `);
  }

  if (await hasColumn(connection, 'commercial_visits', 'location_latitude')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET latitude = COALESCE(latitude, location_latitude)
      WHERE latitude IS NULL
    `);
  }

  if (await hasColumn(connection, 'commercial_visits', 'location_longitude')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET longitude = COALESCE(longitude, location_longitude)
      WHERE longitude IS NULL
    `);
  }

  if (await hasColumn(connection, 'commercial_visits', 'purpose')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET summary = COALESCE(NULLIF(summary, ''), purpose)
      WHERE summary IS NULL OR summary = ''
    `);
  }

  if (await hasColumn(connection, 'commercial_visits', 'result')) {
    await connection.execute(`
      UPDATE commercial_visits
      SET outcome = COALESCE(NULLIF(outcome, ''), result)
      WHERE outcome IS NULL OR outcome = ''
    `);
  }

  await connection.execute(
    "ALTER TABLE commercial_visits MODIFY COLUMN status ENUM('planned', 'completed', 'follow_up', 'cancelled', 'scheduled') NOT NULL DEFAULT 'planned'"
  );
  await connection.execute("UPDATE commercial_visits SET status = 'planned' WHERE status = 'scheduled'");
  await connection.execute(
    "ALTER TABLE commercial_visits MODIFY COLUMN status ENUM('planned', 'completed', 'follow_up', 'cancelled') NOT NULL DEFAULT 'planned'"
  );
};

const ensureCommercialOpportunitiesTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS commercial_opportunities (
      id INT PRIMARY KEY AUTO_INCREMENT,
      client_name VARCHAR(160) NOT NULL,
      contact_name VARCHAR(160) NULL,
      opportunity_name VARCHAR(180) NOT NULL,
      stage ENUM('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'on_hold') NOT NULL DEFAULT 'lead',
      estimated_value DECIMAL(14,2) NOT NULL DEFAULT 0,
      probability INT NOT NULL DEFAULT 15,
      expected_close_date DATE NULL,
      last_activity_date DATE NULL,
      next_step TEXT NULL,
      notes TEXT NULL,
      project_id INT NULL,
      source_visit_id INT NULL,
      owner_user_id INT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_client_name (client_name),
      INDEX idx_stage (stage),
      INDEX idx_expected_close_date (expected_close_date),
      INDEX idx_project_id (project_id),
      INDEX idx_source_visit_id (source_visit_id),
      INDEX idx_owner_user_id (owner_user_id)
    )
  `);

  await ensureColumn(connection, 'commercial_opportunities', 'client_id', 'INT NULL AFTER id');
  await ensureColumn(connection, 'commercial_opportunities', 'contact_name', 'VARCHAR(160) NULL AFTER client_name');
  await ensureColumn(connection, 'commercial_opportunities', 'opportunity_name', 'VARCHAR(180) NOT NULL DEFAULT "Oportunidad comercial" AFTER contact_name');
  await ensureColumn(connection, 'commercial_opportunities', 'stage', "ENUM('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'on_hold') NOT NULL DEFAULT 'lead' AFTER opportunity_name");
  await ensureColumn(connection, 'commercial_opportunities', 'estimated_value', 'DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER stage');
  await ensureColumn(connection, 'commercial_opportunities', 'probability', 'INT NOT NULL DEFAULT 15 AFTER estimated_value');
  await ensureColumn(connection, 'commercial_opportunities', 'expected_close_date', 'DATE NULL AFTER probability');
  await ensureColumn(connection, 'commercial_opportunities', 'last_activity_date', 'DATE NULL AFTER expected_close_date');
  await ensureColumn(connection, 'commercial_opportunities', 'next_step', 'TEXT NULL AFTER last_activity_date');
  await ensureColumn(connection, 'commercial_opportunities', 'notes', 'TEXT NULL AFTER next_step');
  await ensureColumn(connection, 'commercial_opportunities', 'project_id', 'INT NULL AFTER notes');
  await ensureColumn(connection, 'commercial_opportunities', 'source_visit_id', 'INT NULL AFTER project_id');
  await ensureColumn(connection, 'commercial_opportunities', 'owner_user_id', 'INT NULL AFTER source_visit_id');
  await ensureColumn(connection, 'commercial_opportunities', 'created_by', 'INT NULL AFTER owner_user_id');
  await ensureColumn(connection, 'commercial_opportunities', 'updated_at', 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
};

const ensureCommercialFormTemplatesTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS commercial_form_templates (
      id INT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      fields_json LONGTEXT NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_commercial_form_templates_code (code),
      INDEX idx_commercial_form_templates_active (is_active)
    )
  `);

  const [existingRows] = await connection.execute(
    'SELECT id, code FROM commercial_form_templates'
  );
  const existingCodes = new Set(existingRows.map((row) => row.code));

  for (const template of DEFAULT_COMMERCIAL_FORM_TEMPLATES) {
    if (existingCodes.has(template.code)) continue;

    await connection.execute(
      `INSERT INTO commercial_form_templates (
         code,
         name,
         description,
         fields_json,
         is_active,
         created_by,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 1, NULL, NOW(), NOW())`,
      [template.code, template.name, template.description, JSON.stringify(template.fields)]
    );
  }
};

const normalizeClientCity = (value) => (value == null ? '' : value.toString().trim());

const migrateCommercialClientsUniqueKey = async (connection) => {
  const [indexes] = await connection.execute('SHOW INDEX FROM commercial_clients');
  const indexNames = new Set(indexes.map((row) => row.Key_name));
  if (indexNames.has('uk_commercial_clients_nit') && !indexNames.has('uk_commercial_clients_nit_city')) {
    await connection.execute('ALTER TABLE commercial_clients DROP INDEX uk_commercial_clients_nit');
  }
  if (!indexNames.has('uk_commercial_clients_nit_city')) {
    await connection.execute(
      'ALTER TABLE commercial_clients ADD UNIQUE KEY uk_commercial_clients_nit_city (nit, city)',
    );
  }
};

const ensureCommercialClientsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS commercial_clients (
      id INT PRIMARY KEY AUTO_INCREMENT,
      client_type ENUM('juridica', 'natural') NOT NULL,
      nit VARCHAR(80) NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      city VARCHAR(120) NOT NULL,
      billing_email VARCHAR(255) NULL,
      contact_name VARCHAR(150) NULL,
      contact_phone VARCHAR(50) NULL,
      areas JSON NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_commercial_clients_nit_city (nit, city),
      INDEX idx_commercial_clients_name (business_name),
      INDEX idx_commercial_clients_nit (nit)
    )
  `);
  await migrateCommercialClientsUniqueKey(connection);
  await ensureCommercialClientsExtendedColumns(connection);
};

const CLIENT_AREA_KEYS = ['compras', 'cartera', 'hse', 'mantenimiento', 'otros'];

const ensureCommercialClientsExtendedColumns = async (connection) => {
  await ensureColumn(connection, 'commercial_clients', 'rut', 'VARCHAR(80) NULL AFTER city');
  await ensureColumn(connection, 'commercial_clients', 'contact_address', 'VARCHAR(255) NULL AFTER contact_phone');
  await ensureColumn(connection, 'commercial_clients', 'contact_birth_date', 'DATE NULL AFTER contact_address');
  await ensureColumn(connection, 'commercial_clients', 'area_contacts', 'JSON NULL AFTER areas');
};

const ensureVisitLocationsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS visit_locations (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      visit_id INT NOT NULL,
      lat DECIMAL(10,7) NOT NULL,
      lng DECIMAL(10,7) NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recorded_by INT NULL,
      INDEX idx_visit_locations_visit (visit_id)
    )
  `);
};

const ensureQuotationLocationsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS quotation_locations (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      quotation_id BIGINT NOT NULL,
      lat DECIMAL(10,7) NOT NULL,
      lng DECIMAL(10,7) NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recorded_by INT NULL,
      INDEX idx_quotation_locations_quotation (quotation_id)
    )
  `);
};

const ensureNearbyPlacesTables = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS nearby_places (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(80) NULL,
      address VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS visit_nearby_places (
      id INT PRIMARY KEY AUTO_INCREMENT,
      visit_id INT NOT NULL,
      nearby_place_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_vnp_visit (visit_id),
      INDEX idx_vnp_place (nearby_place_id)
    )
  `);
};

const recordVisitLocation = async (connection, { visitId, latitude, longitude, userId }) => {
  if (visitId == null || latitude == null || longitude == null) return;
  await connection.execute(
    `INSERT INTO visit_locations (visit_id, lat, lng, recorded_at, recorded_by)
     VALUES (?, ?, ?, NOW(), ?)`,
    [visitId, latitude, longitude, userId ?? null],
  );
};

const recordQuotationLocation = async (connection, { quotationId, latitude, longitude, userId }) => {
  if (quotationId == null || latitude == null || longitude == null) return;
  await connection.execute(
    `INSERT INTO quotation_locations (quotation_id, lat, lng, recorded_at, recorded_by)
     VALUES (?, ?, ?, NOW(), ?)`,
    [quotationId, latitude, longitude, userId ?? null],
  );
};

const normalizeClientAreas = (value) => {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const areas = value.map((item) => item?.toString().trim()).filter(Boolean);
    return areas.length ? JSON.stringify(areas) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return normalizeClientAreas(parsed);
      }
    } catch (_) {}
    return JSON.stringify(
      trimmed.split(',').map((item) => item.trim()).filter(Boolean),
    );
  }
  return null;
};

const parseClientAreas = (raw) => {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw.toString());
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

const trimOrNull = (value) => {
  const trimmed = (value ?? '').toString().trim();
  return trimmed || null;
};

const parseAreaContacts = (raw) => {
  if (raw == null) return {};
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  CLIENT_AREA_KEYS.forEach((key) => {
    const entry = parsed[key];
    if (!entry || typeof entry !== 'object') return;
    const name = trimOrNull(entry.name);
    const email = trimOrNull(entry.email);
    const phone = trimOrNull(entry.phone);
    if (!name && !email && !phone) return;
    result[key] = { name, email, phone };
  });
  return result;
};

const normalizeAreaContacts = (value) => {
  const parsed = parseAreaContacts(value);
  return Object.keys(parsed).length ? JSON.stringify(parsed) : null;
};

const mergeClientAreas = (areasPayload, areaContactsObj) => {
  const merged = new Set(parseClientAreas(areasPayload));
  Object.entries(areaContactsObj || {}).forEach(([key, entry]) => {
    if (entry?.name) merged.add(key);
  });
  const list = [...merged].filter((item) => CLIENT_AREA_KEYS.includes(item));
  return list.length ? JSON.stringify(list) : null;
};

const assessClientProfile = (row) => {
  const missing = [];
  const billingEmail = trimOrNull(row.billing_email);
  const contactName = trimOrNull(row.contact_name);
  const contactPhone = trimOrNull(row.contact_phone);
  const rut = trimOrNull(row.rut);
  const areaContacts = parseAreaContacts(row.area_contacts);
  const filledAreas = CLIENT_AREA_KEYS.filter((key) => areaContacts[key]?.name);

  if (!billingEmail) missing.push('email_facturacion');
  if (!contactName) missing.push('nombre_contacto');
  if (!contactPhone) missing.push('telefono_contacto');
  if (!rut) missing.push('rut');
  if (filledAreas.length === 0) missing.push('contactos_por_area');

  return {
    profile_complete: missing.length === 0,
    missing_fields: missing,
  };
};

const mapCommercialClientRow = (row) => {
  const city = normalizeClientCity(row.city);
  const businessName = (row.business_name ?? '').toString();
  const areaContacts = parseAreaContacts(row.area_contacts);
  const profile = assessClientProfile(row);
  return {
    id: row.id,
    client_type: row.client_type,
    nit: row.nit,
    business_name: businessName,
    city,
    rut: row.rut,
    display_label: !city ? businessName : `${businessName} · ${city}`,
    billing_email: row.billing_email,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    contact_address: row.contact_address,
    contact_birth_date: normalizeDate(row.contact_birth_date),
    areas: parseClientAreas(row.areas),
    area_contacts: areaContacts,
    profile_complete: profile.profile_complete,
    missing_fields: profile.missing_fields,
    created_by: row.created_by,
    created_by_name: row.created_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const normalizeNearbyPlacePayload = (payload = {}) => ({
  name: (payload.name || '').toString().trim(),
  type: payload.type == null ? null : payload.type.toString().trim(),
  address: payload.address == null ? null : payload.address.toString().trim(),
  phone: payload.phone == null ? null : payload.phone.toString().trim(),
  notes: payload.notes == null ? null : payload.notes.toString().trim(),
});

const attachNearbyPlacesToVisit = async (connection, visitId, nearbyPlaces = [], userId = null) => {
  if (!visitId || !Array.isArray(nearbyPlaces) || nearbyPlaces.length === 0) return [];

  const saved = [];
  for (const rawPlace of nearbyPlaces) {
    const place = normalizeNearbyPlacePayload(rawPlace);
    if (!place.name) continue;

    const [placeResult] = await connection.execute(
      `INSERT INTO nearby_places (name, type, address, phone, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [place.name, place.type, place.address, place.phone, place.notes, userId],
    );

    await connection.execute(
      'INSERT INTO visit_nearby_places (visit_id, nearby_place_id) VALUES (?, ?)',
      [visitId, placeResult.insertId],
    );

    saved.push({ id: placeResult.insertId, ...place });
  }

  return saved;
};

const syncNearbyPlacesForVisit = async (connection, visitId, nearbyPlaces = [], userId = null) => {
  if (!visitId || !Array.isArray(nearbyPlaces)) return [];

  const normalizedPlaces = [];
  for (const rawPlace of nearbyPlaces) {
    const place = normalizeNearbyPlacePayload(rawPlace);
    if (!place.name) continue;
    normalizedPlaces.push({
      id: normalizeNumber(rawPlace?.id),
      ...place,
    });
  }

  const [existingLinks] = await connection.execute(
    `SELECT vnp.nearby_place_id
     FROM visit_nearby_places vnp
     WHERE vnp.visit_id = ?`,
    [visitId],
  );

  const existingIds = new Set(existingLinks.map((row) => Number(row.nearby_place_id)));
  const keptPlaceIds = new Set();
  const saved = [];

  for (const place of normalizedPlaces) {
    if (place.id && existingIds.has(place.id)) {
      await connection.execute(
        `UPDATE nearby_places
         SET name = ?, type = ?, address = ?, phone = ?, notes = ?, updated_at = NOW()
         WHERE id = ?`,
        [place.name, place.type, place.address, place.phone, place.notes, place.id],
      );
      keptPlaceIds.add(place.id);
      saved.push({
        id: place.id,
        name: place.name,
        type: place.type,
        address: place.address,
        phone: place.phone,
        notes: place.notes,
      });
      continue;
    }

    const [placeResult] = await connection.execute(
      `INSERT INTO nearby_places (name, type, address, phone, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [place.name, place.type, place.address, place.phone, place.notes, userId],
    );

    await connection.execute(
      'INSERT INTO visit_nearby_places (visit_id, nearby_place_id) VALUES (?, ?)',
      [visitId, placeResult.insertId],
    );

    keptPlaceIds.add(Number(placeResult.insertId));
    saved.push({ id: placeResult.insertId, ...place });
  }

  for (const placeId of existingIds) {
    if (!keptPlaceIds.has(placeId)) {
      await connection.execute(
        'DELETE FROM visit_nearby_places WHERE visit_id = ? AND nearby_place_id = ?',
        [visitId, placeId],
      );
    }
  }

  return saved;
};

const loadNearbyPlacesByVisitIds = async (connection, visitIds = []) => {
  const normalizedVisitIds = [...new Set(
    visitIds
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  )];
  if (!normalizedVisitIds.length) return new Map();

  const placeholders = normalizedVisitIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT vnp.visit_id, np.id, np.name, np.type, np.address, np.phone, np.notes
     FROM visit_nearby_places vnp
     INNER JOIN nearby_places np ON np.id = vnp.nearby_place_id
     WHERE vnp.visit_id IN (${placeholders})
     ORDER BY vnp.visit_id ASC, vnp.id ASC`,
    normalizedVisitIds,
  );

  const grouped = new Map();
  for (const row of rows) {
    const visitId = Number(row.visit_id);
    const place = {
      id: row.id,
      name: row.name,
      type: row.type,
      address: row.address,
      phone: row.phone,
      notes: row.notes,
    };
    if (!grouped.has(visitId)) grouped.set(visitId, []);
    grouped.get(visitId).push(place);
  }

  return grouped;
};

const enrichVisitsWithNearbyPlaces = async (connection, visits = []) => {
  if (!Array.isArray(visits) || visits.length === 0) return visits;

  const grouped = await loadNearbyPlacesByVisitIds(connection, visits.map((visit) => visit.id));
  return visits.map((visit) => ({
    ...visit,
    nearby_places: grouped.get(Number(visit.id)) || [],
  }));
};

const getNearbyPlacesForVisit = async (connection, visitId) => {
  const [rows] = await connection.execute(
    `SELECT np.id, np.name, np.type, np.address, np.phone, np.notes
     FROM visit_nearby_places vnp
     INNER JOIN nearby_places np ON np.id = vnp.nearby_place_id
     WHERE vnp.visit_id = ?
     ORDER BY vnp.id ASC`,
    [visitId],
  );
  return rows;
};

const ensureCommercialSchema = async (connection) => {
  await ensureCommercialVisitsTable(connection);
  await ensureCommercialOpportunitiesTable(connection);
  await ensureCommercialFormTemplatesTable(connection);
  await ensureCommercialClientsTable(connection);
  await ensureVisitLocationsTable(connection);
  await ensureQuotationLocationsTable(connection);
  await ensureNearbyPlacesTables(connection);
  await ensureCountersTable(connection);
  await ensureQuotationsTable(connection);
  await ensureOrdersOtTable(connection);
};

const ensureCountersTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS counters (
      name VARCHAR(64) PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0
    )
  `);
};

const ensureQuotationsTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS commercial_quotations (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      quotation_number VARCHAR(64) NOT NULL UNIQUE,
      consecutive BIGINT NOT NULL,
      commercial_initials VARCHAR(16) NOT NULL,
      suffix CHAR(1) NOT NULL,
      visit_id INT NULL,
      project_id INT NULL,
      budget DECIMAL(15,2) NOT NULL DEFAULT 0,
      status ENUM('cotizado','aprobado','rechazado') NOT NULL DEFAULT 'cotizado',
      approved_value DECIMAL(15,2) NULL,
      approval_date DATETIME NULL,
      billing_date DATETIME NULL,
      billed_value DECIMAL(15,2) NULL,
      observations TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_visit_id (visit_id),
      INDEX idx_project_id (project_id)
    )
  `);
};

const ensureOrdersOtTable = async (connection) => {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS orders_ot (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      ot_code VARCHAR(128) UNIQUE,
      quotation_id BIGINT NULL,
      assigned_by INT NULL,
      assigned_at DATETIME NULL,
      status ENUM('open','in_progress','closed') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_quotation_id (quotation_id)
    )
  `);
};

const computeInitials = (fullName) => {
  if (!fullName) return '';
  const parts = fullName.toString().trim().split(/\s+/).filter(Boolean);
  const initials = parts.map((p) => p[0].toUpperCase()).join('');
  return initials.slice(0, 4);
};

const createQuotation = async (req, res) => {
  let connection;
  try {
    const payload = req.body || {};
    const visitId = payload.visit_id ? Number(payload.visit_id) : null;
    const projectId = payload.project_id ? Number(payload.project_id) : null;
    const budget = payload.budget ? Number(payload.budget) : 0;
    if (!visitId && !projectId) {
      return res.status(400).json({ success: false, message: 'Se requiere visit_id o project_id para crear una cotización' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    await connection.beginTransaction();

    const initials = computeInitials(req.user?.name || req.user?.fullName || '');
    let consecutive;
    let suffixChar;

    const findExistingGroup = async () => {
      if (visitId) {
        const [rows] = await connection.execute(
          `SELECT consecutive, commercial_initials
           FROM commercial_quotations
           WHERE visit_id = ? AND commercial_initials = ?
           ORDER BY id ASC
           LIMIT 1`,
          [visitId, initials],
        );
        return rows[0] || null;
      }
      if (projectId) {
        const [rows] = await connection.execute(
          `SELECT consecutive, commercial_initials
           FROM commercial_quotations
           WHERE project_id = ? AND commercial_initials = ?
           ORDER BY id ASC
           LIMIT 1`,
          [projectId, initials],
        );
        return rows[0] || null;
      }
      return null;
    };

    const existingGroup = await findExistingGroup();
    if (existingGroup) {
      consecutive = Number(existingGroup.consecutive);
      const base = `${consecutive}${initials}`;
      const [countRows] = await connection.execute(
        'SELECT COUNT(*) as cnt FROM commercial_quotations WHERE quotation_number LIKE ?',
        [`${base}-%`],
      );
      const existingCount = Number(countRows[0].cnt || 0);
      if (existingCount >= 26) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: 'Se alcanzó el límite de cotizaciones (A-Z) para esta visita o proyecto',
        });
      }
      suffixChar = String.fromCharCode(65 + existingCount);
    } else {
      const [counterRows] = await connection.execute('SELECT value FROM counters WHERE name = ? FOR UPDATE', ['quotation']);
      if (counterRows.length === 0) {
        consecutive = 1;
        await connection.execute('INSERT INTO counters (name, value) VALUES (?, ?)', ['quotation', consecutive]);
      } else {
        consecutive = Number(counterRows[0].value || 0) + 1;
        await connection.execute('UPDATE counters SET value = ? WHERE name = ?', [consecutive, 'quotation']);
      }
      suffixChar = 'A';
    }

    const quotationNumber = `${consecutive}${initials}-${suffixChar}`;

    const [result] = await connection.execute(
      `INSERT INTO commercial_quotations (
         quotation_number, consecutive, commercial_initials, suffix, visit_id, project_id, budget, status, observations, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quotationNumber, consecutive, initials, suffixChar, visitId, projectId, budget, 'cotizado', payload.observations || null, req.user?.id ?? null]
    );

    await applyAuditContext(connection, req);

    const normalizedLatitude = normalizeNumber(payload.latitude);
    const normalizedLongitude = normalizeNumber(payload.longitude);
    await recordQuotationLocation(connection, {
      quotationId: result.insertId,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      userId: req.user?.id ?? null,
    });

    await connection.commit();

    const [rows] = await connection.execute('SELECT * FROM commercial_quotations WHERE id = ? LIMIT 1', [result.insertId]);
    res.status(201).json({ success: true, message: 'Cotización creada', data: rows[0] });
  } catch (error) {
    console.error('createQuotation error:', error);
    try { await connection?.rollback(); } catch (_) {}
    res.status(500).json({ success: false, message: 'Error al crear cotización', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialFormTemplates = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureCommercialFormTemplatesTable(connection);

    const includeInactive = ['1', 'true', 'yes'].includes((req.query.include_inactive || '').toString().trim().toLowerCase());
    const [rows] = await connection.execute(
      `SELECT *
       FROM commercial_form_templates
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY is_active DESC, name ASC, id ASC`
    );

    res.json({ success: true, data: rows.map(mapCommercialTemplateRow) });
  } catch (error) {
    console.error('getCommercialFormTemplates error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener formularios comerciales', error: error.message });
  } finally {
    connection?.release();
  }
};

const createCommercialFormTemplate = async (req, res) => {
  let connection;
  try {
    const payload = normalizeTemplatePayload(req.body);
    if (!payload.code || !payload.name) {
      return res.status(400).json({ success: false, message: 'Codigo y nombre del formulario son obligatorios' });
    }
    if (!payload.fields.length) {
      return res.status(400).json({ success: false, message: 'Debes registrar al menos un campo en la plantilla' });
    }

    connection = await pool.getConnection();
    await ensureCommercialFormTemplatesTable(connection);

    const [existingRows] = await connection.execute(
      'SELECT id FROM commercial_form_templates WHERE code = ? LIMIT 1',
      [payload.code]
    );
    if (existingRows.length > 0) {
      return res.status(409).json({ success: false, message: 'Ya existe una plantilla con ese codigo' });
    }

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO commercial_form_templates (
         code,
         name,
         description,
         fields_json,
         is_active,
         created_by,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        payload.code,
        payload.name,
        payload.description,
        JSON.stringify(payload.fields),
        payload.is_active ? 1 : 0,
        req.user?.id ?? null,
      ]
    );

    const [rows] = await connection.execute('SELECT * FROM commercial_form_templates WHERE id = ? LIMIT 1', [result.insertId]);
    res.status(201).json({ success: true, message: 'Plantilla comercial creada', data: mapCommercialTemplateRow(rows[0]) });
  } catch (error) {
    console.error('createCommercialFormTemplate error:', error);
    res.status(500).json({ success: false, message: 'Error al crear plantilla comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const updateCommercialFormTemplate = async (req, res) => {
  let connection;
  try {
    const templateId = normalizeNumber(req.params.id);
    if (!templateId) {
      return res.status(400).json({ success: false, message: 'Identificador de plantilla no valido' });
    }

    const payload = normalizeTemplatePayload(req.body);
    if (!payload.code || !payload.name) {
      return res.status(400).json({ success: false, message: 'Codigo y nombre del formulario son obligatorios' });
    }
    if (!payload.fields.length) {
      return res.status(400).json({ success: false, message: 'Debes registrar al menos un campo en la plantilla' });
    }

    connection = await pool.getConnection();
    await ensureCommercialFormTemplatesTable(connection);

    const [existingRows] = await connection.execute('SELECT * FROM commercial_form_templates WHERE id = ? LIMIT 1', [templateId]);
    if (!existingRows.length) {
      return res.status(404).json({ success: false, message: 'Plantilla comercial no encontrada' });
    }

    const [conflictRows] = await connection.execute(
      'SELECT id FROM commercial_form_templates WHERE code = ? AND id <> ? LIMIT 1',
      [payload.code, templateId]
    );
    if (conflictRows.length > 0) {
      return res.status(409).json({ success: false, message: 'Ya existe otra plantilla con ese codigo' });
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_form_templates
       SET code = ?,
           name = ?,
           description = ?,
           fields_json = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        payload.code,
        payload.name,
        payload.description,
        JSON.stringify(payload.fields),
        payload.is_active ? 1 : 0,
        templateId,
      ]
    );

    const [rows] = await connection.execute('SELECT * FROM commercial_form_templates WHERE id = ? LIMIT 1', [templateId]);
    res.json({ success: true, message: 'Plantilla comercial actualizada', data: mapCommercialTemplateRow(rows[0]) });
  } catch (error) {
    console.error('updateCommercialFormTemplate error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar plantilla comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialVisits = async (req, res) => {
  let connection;
  try {
    const search = (req.query.q || '').toString().trim();
    const status = normalizeStatus(req.query.status);

    if (req.query.status && status === null) {
      return res.status(400).json({ success: false, message: 'Estado comercial no válido' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const filters = [];
    const params = [];

    if (search) {
      filters.push('(cv.client_name LIKE ? OR cv.client_contact LIKE ? OR cv.summary LIKE ? OR cv.outcome LIKE ? OR cv.next_action LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    if (req.query.status) {
      filters.push('cv.status = ?');
      params.push(status);
    }

    pushFilter(filters, params, buildVisitOwnerFilter(req.user?.role, req.user?.id, 'cv'));

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       ${whereClause}
       ORDER BY cv.visit_date DESC, cv.created_at DESC`,
      params,
    );

    const visits = await enrichVisitsWithNearbyPlaces(
      connection,
      rows.map((row) => mapVisitRow(row, req)),
    );

    res.json({ success: true, data: visits });
  } catch (error) {
    console.error('getCommercialVisits error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener visitas comerciales', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialOpportunities = async (req, res) => {
  let connection;
  try {
    const search = (req.query.q || '').toString().trim();
    const stage = normalizeOpportunityStage(req.query.stage);

    if (req.query.stage && stage === null) {
      return res.status(400).json({ success: false, message: 'Etapa comercial no válida' });
    }

    connection = await pool.getConnection();
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const filters = [];
    const params = [];

    if (search) {
      filters.push('(co.client_name LIKE ? OR co.contact_name LIKE ? OR co.opportunity_name LIKE ? OR co.next_step LIKE ? OR co.notes LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    if (req.query.stage) {
      filters.push('co.stage = ?');
      params.push(stage);
    }

    pushFilter(filters, params, buildOpportunityOwnerFilter(req.user?.role, req.user?.id, 'co'));

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await connection.execute(
      `${COMMERCIAL_OPPORTUNITY_SELECT}
       ${whereClause}
       ORDER BY FIELD(co.stage, 'negotiation', 'proposal', 'qualified', 'lead', 'on_hold', 'won', 'lost'),
                COALESCE(co.expected_close_date, '9999-12-31') ASC,
                co.updated_at DESC`,
      params,
    );

    res.json({ success: true, data: rows.map(mapOpportunityRow) });
  } catch (error) {
    console.error('getCommercialOpportunities error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener oportunidades comerciales', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialSummary = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const visitScope = buildVisitOwnerFilter(req.user?.role, req.user?.id, 'cv');
    const opportunityScope = buildOpportunityOwnerFilter(req.user?.role, req.user?.id, 'co');
    const quotationScope = buildQuotationOwnerFilter(req.user?.role, req.user?.id, 'cq');

    const visitWhere = appendSqlFilter('', visitScope);
    const opportunityWhere = appendSqlFilter('', opportunityScope);
    const quotationWhere = appendSqlFilter('', quotationScope);

    const [[visitSummary]] = await connection.execute(
      `SELECT
         COUNT(*) AS total_visits,
         COUNT(DISTINCT client_name) AS unique_clients,
         SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END) AS planned_visits,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_visits,
         SUM(CASE WHEN status = 'follow_up' THEN 1 ELSE 0 END) AS follow_up_visits,
         SUM(CASE WHEN next_action_date IS NOT NULL AND next_action_date < CURDATE() AND status = 'follow_up' THEN 1 ELSE 0 END) AS overdue_follow_ups,
         SUM(CASE WHEN next_action_date IS NOT NULL AND next_action_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS upcoming_actions,
         SUM(CASE WHEN YEAR(visit_date) = YEAR(CURDATE()) AND MONTH(visit_date) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS current_month_visits,
         COALESCE(SUM(expense_amount), 0) AS total_expenses,
         COALESCE(SUM(CASE WHEN YEAR(visit_date) = YEAR(CURDATE()) AND MONTH(visit_date) = MONTH(CURDATE()) THEN expense_amount ELSE 0 END), 0) AS current_month_expenses
       FROM commercial_visits cv
       ${visitWhere.whereClause}`,
      visitWhere.params,
    );

    const [[opportunitySummary]] = await connection.execute(
      `SELECT
         COUNT(*) AS total_opportunities,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN 1 ELSE 0 END) AS active_opportunities,
         SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END) AS won_opportunities,
         SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) AS lost_opportunities,
         SUM(CASE WHEN stage = 'on_hold' THEN 1 ELSE 0 END) AS on_hold_opportunities,
         COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN estimated_value ELSE 0 END), 0) AS pipeline_value,
         COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN estimated_value * (probability / 100) ELSE 0 END), 0) AS weighted_pipeline_value,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND expected_close_date IS NOT NULL AND expected_close_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS closing_30_days,
         ROUND(AVG(CASE WHEN stage NOT IN ('won', 'lost') THEN probability END), 0) AS average_probability
       FROM commercial_opportunities co
       ${opportunityWhere.whereClause}`,
      opportunityWhere.params,
    );

    const [[quotationSummary]] = await connection.execute(
      `SELECT
         COUNT(*) AS total_quotations,
         SUM(CASE WHEN status = 'cotizado' THEN 1 ELSE 0 END) AS pending_quotations,
         SUM(CASE WHEN status = 'aprobado' THEN 1 ELSE 0 END) AS approved_quotations,
         COALESCE(SUM(budget), 0) AS quotation_budget_total
       FROM commercial_quotations cq
       ${quotationWhere.whereClause}`,
      quotationWhere.params,
    );

    const [[clientSummary]] = await connection.execute(
      'SELECT COUNT(*) AS total_clients FROM commercial_clients'
    );

    res.json({
      success: true,
      data: {
        ...visitSummary,
        ...opportunitySummary,
        ...quotationSummary,
        ...clientSummary,
      },
    });
  } catch (error) {
    console.error('getCommercialSummary error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener resumen comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialBoard = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const visitScope = buildVisitOwnerFilter(req.user?.role, req.user?.id, 'cv');
    const opportunityScope = buildOpportunityOwnerFilter(req.user?.role, req.user?.id, 'co');
    const quotationScope = buildQuotationOwnerFilter(req.user?.role, req.user?.id, 'cq');
    const projectScope = buildCommercialProjectVisibilityFilter(req.user?.role, req.user?.id, 'p');

    const visitWhere = appendSqlFilter('', visitScope);
    const opportunityWhere = appendSqlFilter('', opportunityScope);
    const upcomingActionsWhere = appendSqlFilter(
      'WHERE cv.next_action_date IS NOT NULL AND cv.status IN (\'planned\', \'follow_up\')',
      visitScope,
    );
    const urgentOpportunitiesWhere = appendSqlFilter(
      'WHERE co.stage NOT IN (\'won\', \'lost\')',
      opportunityScope,
    );

    const visitSubqueryFilter = visitScope.clause ? `AND ${visitScope.clause}` : '';
    const opportunitySubqueryFilter = opportunityScope.clause ? `AND ${opportunityScope.clause}` : '';
    const quotationSubqueryFilter = quotationScope.clause ? `AND ${quotationScope.clause}` : '';

    const projectSnapshotConditions = [
      'COALESCE(v.visit_count, 0) + COALESCE(o.opportunity_count, 0) + COALESCE(q.quotation_count, 0) > 0',
    ];
    const projectSnapshotParams = [];
    if (projectScope.clause) {
      projectSnapshotConditions.push(projectScope.clause);
      projectSnapshotParams.push(...projectScope.params);
    }

    const [[visitAlerts]] = await connection.execute(
      `SELECT
         SUM(CASE WHEN status = 'follow_up' AND next_action_date IS NOT NULL AND next_action_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_follow_ups,
         SUM(CASE WHEN status = 'planned' AND visit_date = CURDATE() THEN 1 ELSE 0 END) AS visits_today,
         SUM(CASE WHEN status IN ('planned', 'follow_up') THEN 1 ELSE 0 END) AS active_pipeline,
         SUM(CASE WHEN evidence_path IS NULL OR evidence_path = '' THEN 1 ELSE 0 END) AS missing_evidence
       FROM commercial_visits cv
       ${visitWhere.whereClause}`,
      visitWhere.params,
    );

    const [[opportunityAlerts]] = await connection.execute(
      `SELECT
         SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN 1 ELSE 0 END) AS open_opportunities,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND expected_close_date IS NOT NULL AND expected_close_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_opportunities,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND expected_close_date IS NOT NULL AND expected_close_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS closing_this_week,
         SUM(CASE WHEN stage = 'won' AND updated_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS won_last_30_days,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND (last_activity_date IS NULL OR last_activity_date < DATE_SUB(CURDATE(), INTERVAL 14 DAY)) THEN 1 ELSE 0 END) AS stalled_opportunities
       FROM commercial_opportunities co
       ${opportunityWhere.whereClause}`,
      opportunityWhere.params,
    );

    const [topClients] = await connection.execute(
      `SELECT
         cv.client_name,
         COUNT(*) AS visit_count,
         COALESCE(SUM(cv.expense_amount), 0) AS total_expense,
         MAX(cv.visit_date) AS last_visit_date,
         SUM(CASE WHEN cv.status = 'follow_up' THEN 1 ELSE 0 END) AS follow_up_count
       FROM commercial_visits cv
       ${visitWhere.whereClause}
       GROUP BY cv.client_name
       ORDER BY visit_count DESC, total_expense DESC, last_visit_date DESC
       LIMIT 5`,
      visitWhere.params,
    );

    const [upcomingActions] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       ${upcomingActionsWhere.whereClause}
       ORDER BY cv.next_action_date ASC, cv.visit_date DESC
       LIMIT 6`,
      upcomingActionsWhere.params,
    );

    const [opportunityStageSummary] = await connection.execute(
      `SELECT
         co.stage,
         COUNT(*) AS opportunity_count,
         COALESCE(SUM(co.estimated_value), 0) AS estimated_value,
         COALESCE(SUM(co.estimated_value * (co.probability / 100)), 0) AS weighted_value,
         ROUND(AVG(co.probability), 0) AS avg_probability
       FROM commercial_opportunities co
       ${opportunityWhere.whereClause}
       GROUP BY co.stage
       ORDER BY FIELD(co.stage, 'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'on_hold')`,
      opportunityWhere.params,
    );

    const [urgentOpportunities] = await connection.execute(
      `${COMMERCIAL_OPPORTUNITY_SELECT}
       ${urgentOpportunitiesWhere.whereClause}
       ORDER BY CASE WHEN co.expected_close_date IS NOT NULL AND co.expected_close_date < CURDATE() THEN 0 ELSE 1 END,
                COALESCE(co.expected_close_date, '9999-12-31') ASC,
                co.probability DESC,
                co.updated_at DESC
       LIMIT 6`,
      urgentOpportunitiesWhere.params,
    );

    const [projectCommercialSnapshot] = await connection.execute(
      `SELECT
         p.id AS project_id,
         p.name AS project_name,
         COALESCE(v.visit_count, 0) AS visit_count,
         COALESCE(o.opportunity_count, 0) AS opportunity_count,
         COALESCE(q.quotation_count, 0) AS quotation_count,
         COALESCE(o.pipeline_value, 0) AS pipeline_value
       FROM projects p
       LEFT JOIN (
         SELECT cv.project_id, COUNT(*) AS visit_count
         FROM commercial_visits cv
         WHERE cv.project_id IS NOT NULL ${visitSubqueryFilter}
         GROUP BY cv.project_id
       ) v ON v.project_id = p.id
       LEFT JOIN (
         SELECT
           co.project_id,
           COUNT(*) AS opportunity_count,
           COALESCE(SUM(CASE WHEN co.stage NOT IN ('won', 'lost') THEN co.estimated_value ELSE 0 END), 0) AS pipeline_value
         FROM commercial_opportunities co
         WHERE co.project_id IS NOT NULL ${opportunitySubqueryFilter}
         GROUP BY co.project_id
       ) o ON o.project_id = p.id
       LEFT JOIN (
         SELECT cq.project_id, COUNT(*) AS quotation_count
         FROM commercial_quotations cq
         WHERE cq.project_id IS NOT NULL ${quotationSubqueryFilter}
         GROUP BY cq.project_id
       ) q ON q.project_id = p.id
       WHERE ${projectSnapshotConditions.join(' AND ')}
       ORDER BY pipeline_value DESC, visit_count DESC, quotation_count DESC
       LIMIT 8`,
      [
        ...visitScope.params,
        ...opportunityScope.params,
        ...quotationScope.params,
        ...projectSnapshotParams,
      ],
    );

    let geoAudit = [];
    if (canViewInternalLocation(req.user?.role)) {
      const [visitGeoRows] = await connection.execute(
        `SELECT
           cv.id AS visit_id,
           cv.client_name,
           cv.visit_date,
           cv.project_id,
           p.name AS project_name,
           vl.lat AS latitude,
           vl.lng AS longitude,
           vl.recorded_at,
           'visit' AS source_type
         FROM visit_locations vl
         INNER JOIN commercial_visits cv ON cv.id = vl.visit_id
         LEFT JOIN projects p ON p.id = cv.project_id
         ORDER BY vl.recorded_at DESC
         LIMIT 8`,
      );
      const [quotationGeoRows] = await connection.execute(
        `SELECT
           cq.id AS quotation_id,
           cq.quotation_number,
           cq.project_id,
           p.name AS project_name,
           ql.lat AS latitude,
           ql.lng AS longitude,
           ql.recorded_at,
           'quotation' AS source_type
         FROM quotation_locations ql
         INNER JOIN commercial_quotations cq ON cq.id = ql.quotation_id
         LEFT JOIN projects p ON p.id = cq.project_id
         ORDER BY ql.recorded_at DESC
         LIMIT 8`,
      );
      geoAudit = [...visitGeoRows, ...quotationGeoRows]
        .sort((left, right) => new Date(right.recorded_at).getTime() - new Date(left.recorded_at).getTime())
        .slice(0, 10)
        .map((row) => ({
          ...row,
          visit_date: row.visit_date ? normalizeDate(row.visit_date) : null,
          latitude: row.latitude != null ? Number(row.latitude) : null,
          longitude: row.longitude != null ? Number(row.longitude) : null,
        }));
    }

    res.json({
      success: true,
      data: {
        alerts: { ...visitAlerts, ...opportunityAlerts },
        top_clients: topClients.map((row) => ({ ...row, last_visit_date: normalizeDate(row.last_visit_date) })),
        upcoming_actions: upcomingActions.map((row) => mapVisitRow(row, req)),
        opportunity_stage_summary: opportunityStageSummary,
        urgent_opportunities: urgentOpportunities.map(mapOpportunityRow),
        project_commercial_snapshot: projectCommercialSnapshot,
        geo_audit: geoAudit,
      },
    });
  } catch (error) {
    console.error('getCommercialBoard error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener tablero comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialClientHistory = async (req, res) => {
  let connection;
  try {
    const clientName = (req.query.client_name || '').toString().trim();
    if (!clientName) {
      return res.status(400).json({ success: false, message: 'Debes indicar el nombre del cliente' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const clientKey = normalizeClientMatchKey(clientName);
    const visitFilters = ['LOWER(TRIM(cv.client_name)) = ?'];
    const visitParams = [clientKey];
    pushFilter(visitFilters, visitParams, buildVisitOwnerFilter(req.user?.role, req.user?.id, 'cv'));

    const opportunityFilters = ['LOWER(TRIM(co.client_name)) = ?'];
    const opportunityParams = [clientKey];
    pushFilter(opportunityFilters, opportunityParams, buildOpportunityOwnerFilter(req.user?.role, req.user?.id, 'co'));

    const [visitRows] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       WHERE ${visitFilters.join(' AND ')}
       ORDER BY cv.visit_date DESC, cv.created_at DESC`,
      visitParams,
    );
    const [opportunityRows] = await connection.execute(
      `${COMMERCIAL_OPPORTUNITY_SELECT}
       WHERE ${opportunityFilters.join(' AND ')}
       ORDER BY FIELD(co.stage, 'negotiation', 'proposal', 'qualified', 'lead', 'on_hold', 'won', 'lost'),
                COALESCE(co.expected_close_date, '9999-12-31') ASC,
                co.updated_at DESC`,
      opportunityParams,
    );

    const visits = await enrichVisitsWithNearbyPlaces(
      connection,
      visitRows.map((row) => mapVisitRow(row, req)),
    );
    const opportunities = opportunityRows.map(mapOpportunityRow);
    const lastVisit = visits[0] || null;
    const openOpportunities = opportunities.filter((item) => !['won', 'lost'].includes(item.stage));
    const lastSignals = lastVisit
      ? detectVisitAutomationSignals({
          visit: lastVisit,
          payload: lastVisit.form_payload && typeof lastVisit.form_payload === 'object' ? lastVisit.form_payload : parseFormPayload(lastVisit.form_payload),
        })
      : null;

    res.json({
      success: true,
      data: {
        client_name: clientName,
        summary: {
          total_visits: visits.length,
          completed_visits: visits.filter((item) => item.status === 'completed').length,
          follow_up_visits: visits.filter((item) => item.status === 'follow_up').length,
          total_expense: visits.reduce((sum, item) => sum + (normalizeNumber(item.expense_amount) ?? 0), 0),
          last_visit_date: lastVisit?.visit_date || null,
          total_opportunities: opportunities.length,
          active_opportunities: openOpportunities.length,
          pipeline_value: openOpportunities.reduce((sum, item) => sum + (normalizeNumber(item.estimated_value) ?? 0), 0),
          weighted_pipeline_value: openOpportunities.reduce((sum, item) => sum + ((normalizeNumber(item.estimated_value) ?? 0) * ((normalizeNumber(item.probability) ?? 0) / 100)), 0),
        },
        automation: {
          can_create_opportunity: openOpportunities.length === 0,
          recommended_stage: lastSignals?.inferredStage || (lastVisit?.status === 'follow_up' ? 'qualified' : 'lead'),
          recommended_value: lastSignals?.estimatedValue ?? extractPayloadNumber(lastVisit?.form_payload, ['estimated_value', 'potential_value', 'business_value']) ?? 0,
          recommended_next_step: lastVisit?.next_action || null,
          recommended_opportunity_name: lastVisit?.summary || (clientName ? `Oportunidad ${clientName}` : null),
          recommended_contact_name: lastVisit?.client_contact || null,
          recommended_project_id: lastVisit?.project_id ?? null,
          recommended_source_visit_id: lastVisit?.id ?? null,
          recommendation_reasons: lastSignals?.reasonCodes ?? [],
        },
        visits,
        opportunities,
      },
    });
  } catch (error) {
    console.error('getCommercialClientHistory error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener historial comercial del cliente', error: error.message });
  } finally {
    connection?.release();
  }
};

const createCommercialVisit = async (req, res) => {
  let connection;
  try {
    const {
      client_id,
      client_name,
      client_contact,
      visit_date,
      latitude,
      longitude,
      city,
      service_scope,
      site_conditions,
      access_types,
      delivery_time_estimate,
      will_generate_quotation,
      form_type,
      form_payload,
      summary,
      outcome,
      next_action,
      next_action_date,
      evidence_path,
      expense_amount,
      status,
      project_id,
      nearby_places,
    } = req.body;

    const normalizedStatus = normalizeStatus(status);
    const normalizedLatitude = normalizeNumber(latitude);
    const normalizedLongitude = normalizeNumber(longitude);
    const normalizedExpenseAmount = normalizeNumber(expense_amount) ?? 0;
    const normalizedVisitDate = normalizeDate(visit_date);
    const normalizedNextActionDate = normalizeDate(next_action_date);
    const normalizedProjectId = normalizeNumber(project_id);
    const normalizedClientId = normalizeNumber(client_id);
    const normalizedCommercialId = normalizeNumber(req.body.commercial_id) ?? req.user?.id ?? null;
    const serializedPayload = serializeFormPayload(form_payload);
    const willGenerateQuotation = will_generate_quotation === undefined
      ? 0
      : (['1', 'true', 'yes', 1, true].includes(will_generate_quotation) ? 1 : 0);

    if (!normalizedVisitDate) {
      return res.status(400).json({ success: false, message: 'La fecha de visita es obligatoria' });
    }
    if (normalizedLatitude === null || normalizedLongitude === null) {
      return res.status(400).json({ success: false, message: 'La visita debe incluir latitud y longitud' });
    }
    if (normalizedStatus === null) {
      return res.status(400).json({ success: false, message: 'Estado comercial no válido' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const clientResolution = await resolveRegisteredCommercialClient(connection, normalizedClientId);
    if (clientResolution.error) {
      return res.status(400).json({ success: false, message: clientResolution.error });
    }
    const registeredClient = clientResolution.client;
    const resolvedClientName = registeredClient.business_name;
    const resolvedClientContact = client_contact?.toString().trim()
      || registeredClient.contact_name
      || null;
    const resolvedCity = city?.toString().trim() || registeredClient.city || null;

    await applyAuditContext(connection, req);

    const [result] = await connection.execute(
      `INSERT INTO commercial_visits (
         client_id,
         client_name,
         client_contact,
         visit_date,
         city,
         service_scope,
         site_conditions,
         access_types,
         delivery_time_estimate,
         will_generate_quotation,
         commercial_id,
         latitude,
         longitude,
         form_type,
         form_payload,
         summary,
         outcome,
         next_action,
         next_action_date,
         evidence_path,
         expense_amount,
         status,
         project_id,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        registeredClient.id,
        resolvedClientName,
        resolvedClientContact,
        normalizedVisitDate,
        resolvedCity,
        service_scope == null ? null : service_scope.toString().trim(),
        site_conditions == null ? null : site_conditions.toString().trim(),
        access_types == null ? null : access_types.toString().trim(),
        delivery_time_estimate == null ? null : delivery_time_estimate.toString().trim(),
        willGenerateQuotation,
        normalizedCommercialId,
        normalizedLatitude,
        normalizedLongitude,
        form_type ? form_type.toString().trim() : null,
        serializedPayload,
        summary ? summary.toString().trim() : null,
        outcome ? outcome.toString().trim() : null,
        next_action ? next_action.toString().trim() : null,
        normalizedNextActionDate,
        evidence_path ? evidence_path.toString().trim() : null,
        normalizedExpenseAmount,
        normalizedStatus,
        normalizedProjectId,
        req.user?.id ?? null,
      ],
    );

    await recordVisitLocation(connection, {
      visitId: result.insertId,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      userId: req.user?.id ?? null,
    });

    const savedNearbyPlaces = await attachNearbyPlacesToVisit(
      connection,
      result.insertId,
      nearby_places,
      req.user?.id ?? null,
    );

    const [rows] = await connection.execute(`${COMMERCIAL_VISIT_SELECT} WHERE cv.id = ?`, [result.insertId]);
    const visitRow = mapVisitRow(rows[0], req);
    visitRow.nearby_places = savedNearbyPlaces;
    const automationResult = await upsertOpportunityFromVisit({ connection, req, visit: visitRow });
    res.status(201).json({
      success: true,
      message: automationResult
        ? `Visita comercial registrada y oportunidad ${automationResult.action === 'created' ? 'creada' : 'actualizada'}`
        : 'Visita comercial registrada',
      data: visitRow,
      automation: automationResult,
    });
  } catch (error) {
    console.error('createCommercialVisit error:', error);
    res.status(500).json({ success: false, message: 'Error al crear visita comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const updateCommercialVisit = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const [existingRows] = await connection.execute('SELECT * FROM commercial_visits WHERE id = ? LIMIT 1', [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Visita comercial no encontrada' });
    }

    const existing = existingRows[0];
    if (!ownsCommercialVisit(existing, req.user?.role, req.user?.id)) {
      return res.status(404).json({ success: false, message: 'Visita comercial no encontrada' });
    }

    const nextStatus = req.body.status == null ? existing.status : normalizeStatus(req.body.status);
    const nextVisitDate = req.body.visit_date == null ? existing.visit_date : normalizeDate(req.body.visit_date);
    const nextLatitude = req.body.latitude == null ? normalizeNumber(existing.latitude) : normalizeNumber(req.body.latitude);
    const nextLongitude = req.body.longitude == null ? normalizeNumber(existing.longitude) : normalizeNumber(req.body.longitude);
    const nextActionDate = req.body.next_action_date == null ? normalizeDate(existing.next_action_date) : normalizeDate(req.body.next_action_date);
    const nextWillGenerateQuotation = req.body.will_generate_quotation === undefined
      ? Number(existing.will_generate_quotation || 0)
      : (['1', 'true', 'yes', 1, true].includes(req.body.will_generate_quotation) ? 1 : 0);

    if (nextStatus === null) {
      return res.status(400).json({ success: false, message: 'Estado comercial no válido' });
    }
    if (!nextVisitDate) {
      return res.status(400).json({ success: false, message: 'La fecha de visita es obligatoria' });
    }
    if (nextLatitude === null || nextLongitude === null) {
      return res.status(400).json({ success: false, message: 'La visita debe incluir latitud y longitud' });
    }

    const nextClientId = req.body.client_id == null ? existing.client_id : normalizeNumber(req.body.client_id);
    const clientResolution = await resolveRegisteredCommercialClient(connection, nextClientId);
    if (clientResolution.error) {
      return res.status(400).json({ success: false, message: clientResolution.error });
    }
    const registeredClient = clientResolution.client;
    const resolvedClientName = registeredClient.business_name;
    const resolvedClientContact = req.body.client_contact == null
      ? (existing.client_contact || registeredClient.contact_name || null)
      : (req.body.client_contact?.toString().trim() || registeredClient.contact_name || null);
    const resolvedCity = req.body.city == null
      ? (existing.city || registeredClient.city || null)
      : (req.body.city?.toString().trim() || registeredClient.city || null);

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_visits
       SET client_id = ?,
           client_name = ?,
           client_contact = ?,
           visit_date = ?,
           city = ?,
           service_scope = ?,
           site_conditions = ?,
           access_types = ?,
           delivery_time_estimate = ?,
           will_generate_quotation = ?,
           commercial_id = ?,
           latitude = ?,
           longitude = ?,
           form_type = ?,
           form_payload = ?,
           summary = ?,
           outcome = ?,
           next_action = ?,
           next_action_date = ?,
           evidence_path = ?,
           expense_amount = ?,
           status = ?,
           project_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        registeredClient.id,
        resolvedClientName,
        resolvedClientContact,
        nextVisitDate,
        resolvedCity,
        req.body.service_scope == null ? existing.service_scope : (req.body.service_scope?.toString().trim() || null),
        req.body.site_conditions == null ? existing.site_conditions : (req.body.site_conditions?.toString().trim() || null),
        req.body.access_types == null ? existing.access_types : (req.body.access_types?.toString().trim() || null),
        req.body.delivery_time_estimate == null
          ? existing.delivery_time_estimate
          : (req.body.delivery_time_estimate?.toString().trim() || null),
        nextWillGenerateQuotation,
        req.body.commercial_id == null
          ? (existing.commercial_id ?? req.user?.id ?? null)
          : normalizeNumber(req.body.commercial_id),
        nextLatitude,
        nextLongitude,
        req.body.form_type == null ? existing.form_type : (req.body.form_type?.toString().trim() || null),
        req.body.form_payload == null ? existing.form_payload : serializeFormPayload(req.body.form_payload),
        req.body.summary == null ? existing.summary : (req.body.summary?.toString().trim() || null),
        req.body.outcome == null ? existing.outcome : (req.body.outcome?.toString().trim() || null),
        req.body.next_action == null ? existing.next_action : (req.body.next_action?.toString().trim() || null),
        nextActionDate,
        req.body.evidence_path == null ? existing.evidence_path : (req.body.evidence_path?.toString().trim() || null),
        req.body.expense_amount == null ? existing.expense_amount : (normalizeNumber(req.body.expense_amount) ?? 0),
        nextStatus,
        req.body.project_id == null ? existing.project_id : normalizeNumber(req.body.project_id),
        id,
      ],
    );

    if (req.body.latitude != null || req.body.longitude != null) {
      await recordVisitLocation(connection, {
        visitId: Number(id),
        latitude: nextLatitude,
        longitude: nextLongitude,
        userId: req.user?.id ?? null,
      });
    }

    if (Array.isArray(req.body.nearby_places)) {
      await syncNearbyPlacesForVisit(
        connection,
        Number(id),
        req.body.nearby_places,
        req.user?.id ?? null,
      );
    }

    const [rows] = await connection.execute(`${COMMERCIAL_VISIT_SELECT} WHERE cv.id = ?`, [id]);
    const visitRow = mapVisitRow(rows[0], req);
    visitRow.nearby_places = await getNearbyPlacesForVisit(connection, Number(id));
    const automationResult = await upsertOpportunityFromVisit({ connection, req, visit: visitRow });
    res.json({
      success: true,
      message: automationResult
        ? `Visita comercial actualizada y oportunidad ${automationResult.action === 'created' ? 'creada' : 'actualizada'}`
        : 'Visita comercial actualizada',
      data: visitRow,
      automation: automationResult,
    });
  } catch (error) {
    console.error('updateCommercialVisit error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar visita comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const listCommercialClients = async (req, res) => {
  let connection;
  try {
    const search = (req.query.q || '').toString().trim();
    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const filters = [];
    const params = [];
    if (search) {
      filters.push('(business_name LIKE ? OR nit LIKE ? OR city LIKE ? OR contact_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await connection.execute(
      `SELECT cc.*, creator.name AS created_by_name
       FROM commercial_clients cc
       LEFT JOIN users creator ON creator.id = cc.created_by
       ${whereClause}
       ORDER BY cc.business_name ASC, cc.city ASC
       LIMIT 500`,
      params,
    );

    res.json({ success: true, data: rows.map(mapCommercialClientRow) });
  } catch (error) {
    console.error('listCommercialClients error:', error);
    res.status(500).json({ success: false, message: 'Error al listar clientes comerciales', error: error.message });
  } finally {
    connection?.release();
  }
};

const getCommercialClientById = async (req, res) => {
  let connection;
  try {
    const clientId = normalizeNumber(req.params.id);
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Identificador de cliente no válido' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);
    const [rows] = await connection.execute('SELECT * FROM commercial_clients WHERE id = ? LIMIT 1', [clientId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Cliente comercial no encontrado' });
    }

    res.json({ success: true, data: mapCommercialClientRow(rows[0]) });
  } catch (error) {
    console.error('getCommercialClientById error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener cliente comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const createCommercialClient = async (req, res) => {
  let connection;
  try {
    const payload = req.body || {};
    const clientType = (payload.client_type || '').toString().trim().toLowerCase();
    const nit = (payload.nit || '').toString().trim();
    const businessName = (payload.business_name || '').toString().trim();
    const city = normalizeClientCity(payload.city);
    const billingEmail = (payload.billing_email || '').toString().trim();
    const contactName = (payload.contact_name || '').toString().trim();
    const contactPhone = (payload.contact_phone || '').toString().trim();
    const rut = (payload.rut || '').toString().trim();
    const contactAddress = (payload.contact_address || '').toString().trim();
    const contactBirthDate = normalizeDate(payload.contact_birth_date);
    const areaContactsObj = parseAreaContacts(payload.area_contacts);
    const areasJson = mergeClientAreas(payload.areas, areaContactsObj);
    const areaContactsJson = normalizeAreaContacts(areaContactsObj);

    if (!['juridica', 'natural'].includes(clientType)) {
      return res.status(400).json({ success: false, message: 'Tipo de cliente inválido (juridica o natural)' });
    }
    if (!nit) {
      return res.status(400).json({ success: false, message: 'NIT / identificación es obligatorio' });
    }
    if (!businessName) {
      return res.status(400).json({ success: false, message: 'Razón social es obligatoria' });
    }
    if (!city) {
      return res.status(400).json({ success: false, message: 'Ciudad / sede es obligatoria para diferenciar puntos del mismo NIT' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const [existingRows] = await connection.execute(
      'SELECT id, city FROM commercial_clients WHERE nit = ? AND LOWER(TRIM(city)) = LOWER(?) LIMIT 1',
      [nit, city],
    );
    if (existingRows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Ya existe una sede de este cliente en ${existingRows[0].city}. Busca por NIT y selecciona la ciudad correcta.`,
      });
    }

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO commercial_clients (
         client_type, nit, business_name, city, rut, billing_email, contact_name, contact_phone,
         contact_address, contact_birth_date, areas, area_contacts, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientType,
        nit,
        businessName,
        city,
        rut || null,
        billingEmail || null,
        contactName || null,
        contactPhone || null,
        contactAddress || null,
        contactBirthDate,
        areasJson,
        areaContactsJson,
        req.user?.id ?? null,
      ],
    );

    const [rows] = await connection.execute('SELECT * FROM commercial_clients WHERE id = ? LIMIT 1', [result.insertId]);
    res.status(201).json({ success: true, message: 'Cliente comercial registrado', data: mapCommercialClientRow(rows[0]) });
  } catch (error) {
    console.error('createCommercialClient error:', error);
    res.status(500).json({ success: false, message: 'Error al crear cliente comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const updateCommercialClient = async (req, res) => {
  let connection;
  try {
    const clientId = normalizeNumber(req.params.id);
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Identificador de cliente no válido' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);

    const [existingRows] = await connection.execute('SELECT * FROM commercial_clients WHERE id = ? LIMIT 1', [clientId]);
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cliente comercial no encontrado' });
    }

    const existing = existingRows[0];
    const payload = req.body || {};
    const clientType = payload.client_type == null
      ? existing.client_type
      : payload.client_type.toString().trim().toLowerCase();
    const nit = payload.nit == null ? existing.nit : payload.nit.toString().trim();
    const businessName = payload.business_name == null
      ? existing.business_name
      : payload.business_name.toString().trim();
    const city = payload.city == null ? normalizeClientCity(existing.city) : normalizeClientCity(payload.city);
    const rut = payload.rut === undefined ? existing.rut : trimOrNull(payload.rut);
    const billingEmail = payload.billing_email === undefined ? existing.billing_email : trimOrNull(payload.billing_email);
    const contactName = payload.contact_name === undefined ? existing.contact_name : trimOrNull(payload.contact_name);
    const contactPhone = payload.contact_phone === undefined ? existing.contact_phone : trimOrNull(payload.contact_phone);
    const contactAddress = payload.contact_address === undefined
      ? existing.contact_address
      : trimOrNull(payload.contact_address);
    const contactBirthDate = payload.contact_birth_date === undefined
      ? normalizeDate(existing.contact_birth_date)
      : normalizeDate(payload.contact_birth_date);

    if (!['juridica', 'natural'].includes(clientType)) {
      return res.status(400).json({ success: false, message: 'Tipo de cliente inválido (juridica o natural)' });
    }
    if (!nit) {
      return res.status(400).json({ success: false, message: 'NIT / identificación es obligatorio' });
    }
    if (!businessName) {
      return res.status(400).json({ success: false, message: 'Razón social es obligatoria' });
    }
    if (!city) {
      return res.status(400).json({ success: false, message: 'Ciudad / sede es obligatoria' });
    }

    const [duplicateRows] = await connection.execute(
      'SELECT id FROM commercial_clients WHERE nit = ? AND LOWER(TRIM(city)) = LOWER(?) AND id <> ? LIMIT 1',
      [nit, city, clientId],
    );
    if (duplicateRows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Ya existe otra sede de este cliente en ${city}.`,
      });
    }

    const nextAreaContactsObj = payload.area_contacts === undefined
      ? parseAreaContacts(existing.area_contacts)
      : parseAreaContacts(payload.area_contacts);
    const nextAreasJson = payload.areas === undefined && payload.area_contacts === undefined
      ? existing.areas
      : mergeClientAreas(payload.areas ?? parseClientAreas(existing.areas), nextAreaContactsObj);
    const nextAreaContactsJson = normalizeAreaContacts(nextAreaContactsObj);

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_clients
       SET client_type = ?,
           nit = ?,
           business_name = ?,
           city = ?,
           rut = ?,
           billing_email = ?,
           contact_name = ?,
           contact_phone = ?,
           contact_address = ?,
           contact_birth_date = ?,
           areas = ?,
           area_contacts = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        clientType,
        nit,
        businessName,
        city,
        rut,
        billingEmail,
        contactName,
        contactPhone,
        contactAddress,
        contactBirthDate,
        nextAreasJson,
        nextAreaContactsJson,
        clientId,
      ],
    );

    const [rows] = await connection.execute('SELECT * FROM commercial_clients WHERE id = ? LIMIT 1', [clientId]);
    res.json({ success: true, message: 'Cliente comercial actualizado', data: mapCommercialClientRow(rows[0]) });
  } catch (error) {
    console.error('updateCommercialClient error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar cliente comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const getVisitNearbyPlaces = async (req, res) => {
  let connection;
  try {
    const visitId = normalizeNumber(req.params.id);
    if (!visitId) {
      return res.status(400).json({ success: false, message: 'Identificador de visita no válido' });
    }

    connection = await pool.getConnection();
    await ensureCommercialSchema(connection);
    const [visitRows] = await connection.execute('SELECT id FROM commercial_visits WHERE id = ? LIMIT 1', [visitId]);
    if (!visitRows.length) {
      return res.status(404).json({ success: false, message: 'Visita comercial no encontrada' });
    }

    const places = await getNearbyPlacesForVisit(connection, visitId);
    res.json({ success: true, data: places });
  } catch (error) {
    console.error('getVisitNearbyPlaces error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener lugares cercanos', error: error.message });
  } finally {
    connection?.release();
  }
};

const createCommercialOpportunity = async (req, res) => {
  let connection;
  try {
    const {
      client_id,
      client_name,
      contact_name,
      opportunity_name,
      stage,
      estimated_value,
      probability,
      expected_close_date,
      last_activity_date,
      next_step,
      notes,
      project_id,
      source_visit_id,
      owner_user_id,
    } = req.body;

    const normalizedStage = normalizeOpportunityStage(stage);
    const normalizedEstimatedValue = normalizeNumber(estimated_value) ?? 0;
    const normalizedProbability = normalizeProbability(probability, normalizedStage || 'lead');
    const normalizedExpectedCloseDate = normalizeDate(expected_close_date);
    const normalizedLastActivityDate = normalizeDate(last_activity_date) || normalizeDate(new Date());
    const normalizedProjectId = normalizeNumber(project_id);
    const normalizedSourceVisitId = normalizeNumber(source_visit_id);
    const normalizedOwnerUserId = normalizeNumber(owner_user_id) ?? req.user?.id ?? null;
    let normalizedClientId = normalizeNumber(client_id);

    if (!opportunity_name || !opportunity_name.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El nombre de la oportunidad es obligatorio' });
    }
    if (normalizedStage === null) {
      return res.status(400).json({ success: false, message: 'Etapa comercial no válida' });
    }
    if (normalizedProbability === null) {
      return res.status(400).json({ success: false, message: 'La probabilidad debe estar entre 0 y 100' });
    }

    connection = await pool.getConnection();
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    if (normalizedSourceVisitId !== null) {
      const [visitRows] = await connection.execute(
        'SELECT id, client_id FROM commercial_visits WHERE id = ? LIMIT 1',
        [normalizedSourceVisitId],
      );
      if (visitRows.length === 0) {
        return res.status(400).json({ success: false, message: 'La visita comercial vinculada no existe' });
      }
      if (!normalizedClientId) {
        normalizedClientId = normalizeNumber(visitRows[0].client_id);
      }
    }

    const clientResolution = await resolveRegisteredCommercialClient(connection, normalizedClientId);
    if (clientResolution.error) {
      return res.status(400).json({ success: false, message: clientResolution.error });
    }
    const registeredClient = clientResolution.client;
    const resolvedClientName = registeredClient.business_name;
    const resolvedContactName = contact_name?.toString().trim()
      || registeredClient.contact_name
      || null;

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO commercial_opportunities (
         client_id,
         client_name,
         contact_name,
         opportunity_name,
         stage,
         estimated_value,
         probability,
         expected_close_date,
         last_activity_date,
         next_step,
         notes,
         project_id,
         source_visit_id,
         owner_user_id,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        registeredClient.id,
        resolvedClientName,
        resolvedContactName,
        opportunity_name.toString().trim(),
        normalizedStage,
        normalizedEstimatedValue,
        normalizedProbability,
        normalizedExpectedCloseDate,
        normalizedLastActivityDate,
        next_step ? next_step.toString().trim() : null,
        notes ? notes.toString().trim() : null,
        normalizedProjectId,
        normalizedSourceVisitId,
        normalizedOwnerUserId,
        req.user?.id ?? null,
      ],
    );

    const [rows] = await connection.execute(`${COMMERCIAL_OPPORTUNITY_SELECT} WHERE co.id = ?`, [result.insertId]);
    res.status(201).json({ success: true, message: 'Oportunidad comercial registrada', data: mapOpportunityRow(rows[0]) });
  } catch (error) {
    console.error('createCommercialOpportunity error:', error);
    res.status(500).json({ success: false, message: 'Error al crear oportunidad comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

const updateCommercialOpportunity = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const [existingRows] = await connection.execute('SELECT * FROM commercial_opportunities WHERE id = ? LIMIT 1', [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Oportunidad comercial no encontrada' });
    }

    const existing = existingRows[0];
    if (!ownsCommercialOpportunity(existing, req.user?.role, req.user?.id)) {
      return res.status(404).json({ success: false, message: 'Oportunidad comercial no encontrada' });
    }

    const nextStage = req.body.stage == null ? existing.stage : normalizeOpportunityStage(req.body.stage);
    const nextEstimatedValue = req.body.estimated_value == null ? (normalizeNumber(existing.estimated_value) ?? 0) : (normalizeNumber(req.body.estimated_value) ?? 0);
    const nextProbability = req.body.probability == null
      ? (req.body.stage == null ? existing.probability : normalizeProbability(null, nextStage || existing.stage))
      : normalizeProbability(req.body.probability, nextStage || existing.stage);
    const nextExpectedCloseDate = req.body.expected_close_date == null ? normalizeDate(existing.expected_close_date) : normalizeDate(req.body.expected_close_date);
    const nextLastActivityDate = req.body.last_activity_date === undefined ? normalizeDate(new Date()) : normalizeDate(req.body.last_activity_date);
    const nextProjectId = req.body.project_id == null ? existing.project_id : normalizeNumber(req.body.project_id);
    const nextSourceVisitId = req.body.source_visit_id == null ? existing.source_visit_id : normalizeNumber(req.body.source_visit_id);
    const nextOwnerUserId = req.body.owner_user_id == null ? existing.owner_user_id : normalizeNumber(req.body.owner_user_id);

    if (nextStage === null) {
      return res.status(400).json({ success: false, message: 'Etapa comercial no válida' });
    }
    if (nextProbability === null) {
      return res.status(400).json({ success: false, message: 'La probabilidad debe estar entre 0 y 100' });
    }
    if (!(req.body.opportunity_name ?? existing.opportunity_name)?.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El nombre de la oportunidad es obligatorio' });
    }

    const nextClientId = req.body.client_id == null ? existing.client_id : normalizeNumber(req.body.client_id);
    let resolvedClientId = nextClientId;
    if (!resolvedClientId && nextSourceVisitId !== null) {
      const [visitRows] = await connection.execute(
        'SELECT client_id FROM commercial_visits WHERE id = ? LIMIT 1',
        [nextSourceVisitId],
      );
      if (visitRows.length > 0) {
        resolvedClientId = normalizeNumber(visitRows[0].client_id);
      }
    }

    const clientResolution = await resolveRegisteredCommercialClient(connection, resolvedClientId);
    if (clientResolution.error) {
      return res.status(400).json({ success: false, message: clientResolution.error });
    }
    const registeredClient = clientResolution.client;
    const resolvedClientName = registeredClient.business_name;
    const resolvedContactName = req.body.contact_name == null
      ? (existing.contact_name || registeredClient.contact_name || null)
      : (req.body.contact_name?.toString().trim() || registeredClient.contact_name || null);

    if (nextSourceVisitId !== null) {
      const [visitRows] = await connection.execute('SELECT id FROM commercial_visits WHERE id = ? LIMIT 1', [nextSourceVisitId]);
      if (visitRows.length === 0) {
        return res.status(400).json({ success: false, message: 'La visita comercial vinculada no existe' });
      }
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_opportunities
       SET client_id = ?,
           client_name = ?,
           contact_name = ?,
           opportunity_name = ?,
           stage = ?,
           estimated_value = ?,
           probability = ?,
           expected_close_date = ?,
           last_activity_date = ?,
           next_step = ?,
           notes = ?,
           project_id = ?,
           source_visit_id = ?,
           owner_user_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        registeredClient.id,
        resolvedClientName,
        resolvedContactName,
        (req.body.opportunity_name ?? existing.opportunity_name).toString().trim(),
        nextStage,
        nextEstimatedValue,
        nextProbability,
        nextExpectedCloseDate,
        nextLastActivityDate,
        req.body.next_step == null ? existing.next_step : (req.body.next_step?.toString().trim() || null),
        req.body.notes == null ? existing.notes : (req.body.notes?.toString().trim() || null),
        nextProjectId,
        nextSourceVisitId,
        nextOwnerUserId,
        id,
      ],
    );

    const [rows] = await connection.execute(`${COMMERCIAL_OPPORTUNITY_SELECT} WHERE co.id = ?`, [id]);
    res.json({ success: true, message: 'Oportunidad comercial actualizada', data: mapOpportunityRow(rows[0]) });
  } catch (error) {
    console.error('updateCommercialOpportunity error:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar oportunidad comercial', error: error.message });
  } finally {
    connection?.release();
  }
};

module.exports = {
  getCommercialFormTemplates,
  getCommercialVisits,
  getCommercialOpportunities,
  getCommercialSummary,
  getCommercialBoard,
  getCommercialClientHistory,
  listCommercialClients,
  getCommercialClientById,
  createCommercialClient,
  updateCommercialClient,
  getVisitNearbyPlaces,
  createCommercialFormTemplate,
  createCommercialVisit,
  updateCommercialFormTemplate,
  updateCommercialVisit,
  createCommercialOpportunity,
  updateCommercialOpportunity,
  createQuotation,
  listQuotations,
  getQuotationById,
  approveQuotation,
  ensureCommercialSchema,
};
