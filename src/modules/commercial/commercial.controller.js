const db = require('../../config/database');
const { applyAuditContext } = require('../../utils/auditContext');

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

const COMMERCIAL_VISIT_SELECT = `SELECT
  cv.id,
  cv.client_name,
  cv.client_contact,
  cv.visit_date,
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
  cv.created_by,
  cv.created_at,
  cv.updated_at,
  p.name AS project_name,
  u.name AS created_by_name
FROM commercial_visits cv
LEFT JOIN projects p ON cv.project_id = p.id
LEFT JOIN users u ON cv.created_by = u.id`;

const COMMERCIAL_OPPORTUNITY_SELECT = `SELECT
  co.id,
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
       SET client_name = ?,
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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

const mapVisitRow = (row) => ({
  ...row,
  visit_date: normalizeDate(row.visit_date),
  next_action_date: normalizeDate(row.next_action_date),
  form_payload: parseFormPayload(row.form_payload),
});

const mapOpportunityRow = (row) => ({
  ...row,
  expected_close_date: normalizeDate(row.expected_close_date),
  last_activity_date: normalizeDate(row.last_activity_date),
  source_visit_date: normalizeDate(row.source_visit_date),
});

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

const ensureCommercialSchema = async (connection) => {
  await ensureCommercialVisitsTable(connection);
  await ensureCommercialOpportunitiesTable(connection);
  await ensureCommercialFormTemplatesTable(connection);
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
    await ensureCommercialVisitsTable(connection);

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

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       ${whereClause}
       ORDER BY cv.visit_date DESC, cv.created_at DESC`,
      params,
    );

    res.json({ success: true, data: rows.map(mapVisitRow) });
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
       FROM commercial_visits`
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
       FROM commercial_opportunities`
    );

    res.json({ success: true, data: { ...visitSummary, ...opportunitySummary } });
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
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const [[visitAlerts]] = await connection.execute(
      `SELECT
         SUM(CASE WHEN status = 'follow_up' AND next_action_date IS NOT NULL AND next_action_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_follow_ups,
         SUM(CASE WHEN status = 'planned' AND visit_date = CURDATE() THEN 1 ELSE 0 END) AS visits_today,
         SUM(CASE WHEN status IN ('planned', 'follow_up') THEN 1 ELSE 0 END) AS active_pipeline,
         SUM(CASE WHEN evidence_path IS NULL OR evidence_path = '' THEN 1 ELSE 0 END) AS missing_evidence
       FROM commercial_visits`
    );

    const [[opportunityAlerts]] = await connection.execute(
      `SELECT
         SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN 1 ELSE 0 END) AS open_opportunities,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND expected_close_date IS NOT NULL AND expected_close_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_opportunities,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND expected_close_date IS NOT NULL AND expected_close_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS closing_this_week,
         SUM(CASE WHEN stage = 'won' AND updated_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS won_last_30_days,
         SUM(CASE WHEN stage NOT IN ('won', 'lost') AND (last_activity_date IS NULL OR last_activity_date < DATE_SUB(CURDATE(), INTERVAL 14 DAY)) THEN 1 ELSE 0 END) AS stalled_opportunities
       FROM commercial_opportunities`
    );

    const [topClients] = await connection.execute(
      `SELECT
         client_name,
         COUNT(*) AS visit_count,
         COALESCE(SUM(expense_amount), 0) AS total_expense,
         MAX(visit_date) AS last_visit_date,
         SUM(CASE WHEN status = 'follow_up' THEN 1 ELSE 0 END) AS follow_up_count
       FROM commercial_visits
       GROUP BY client_name
       ORDER BY visit_count DESC, total_expense DESC, last_visit_date DESC
       LIMIT 5`
    );

    const [upcomingActions] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       WHERE cv.next_action_date IS NOT NULL AND cv.status IN ('planned', 'follow_up')
       ORDER BY cv.next_action_date ASC, cv.visit_date DESC
       LIMIT 6`
    );

    const [opportunityStageSummary] = await connection.execute(
      `SELECT
         stage,
         COUNT(*) AS opportunity_count,
         COALESCE(SUM(estimated_value), 0) AS estimated_value,
         COALESCE(SUM(estimated_value * (probability / 100)), 0) AS weighted_value,
         ROUND(AVG(probability), 0) AS avg_probability
       FROM commercial_opportunities
       GROUP BY stage
       ORDER BY FIELD(stage, 'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'on_hold')`
    );

    const [urgentOpportunities] = await connection.execute(
      `${COMMERCIAL_OPPORTUNITY_SELECT}
       WHERE co.stage NOT IN ('won', 'lost')
       ORDER BY CASE WHEN co.expected_close_date IS NOT NULL AND co.expected_close_date < CURDATE() THEN 0 ELSE 1 END,
                COALESCE(co.expected_close_date, '9999-12-31') ASC,
                co.probability DESC,
                co.updated_at DESC
       LIMIT 6`
    );

    res.json({
      success: true,
      data: {
        alerts: { ...visitAlerts, ...opportunityAlerts },
        top_clients: topClients.map((row) => ({ ...row, last_visit_date: normalizeDate(row.last_visit_date) })),
        upcoming_actions: upcomingActions.map(mapVisitRow),
        opportunity_stage_summary: opportunityStageSummary,
        urgent_opportunities: urgentOpportunities.map(mapOpportunityRow),
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
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const clientKey = normalizeClientMatchKey(clientName);
    const [visitRows] = await connection.execute(
      `${COMMERCIAL_VISIT_SELECT}
       WHERE LOWER(TRIM(cv.client_name)) = ?
       ORDER BY cv.visit_date DESC, cv.created_at DESC`,
      [clientKey],
    );
    const [opportunityRows] = await connection.execute(
      `${COMMERCIAL_OPPORTUNITY_SELECT}
       WHERE LOWER(TRIM(co.client_name)) = ?
       ORDER BY FIELD(co.stage, 'negotiation', 'proposal', 'qualified', 'lead', 'on_hold', 'won', 'lost'),
                COALESCE(co.expected_close_date, '9999-12-31') ASC,
                co.updated_at DESC`,
      [clientKey],
    );

    const visits = visitRows.map(mapVisitRow);
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
      client_name,
      client_contact,
      visit_date,
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
    } = req.body;

    const normalizedStatus = normalizeStatus(status);
    const normalizedLatitude = normalizeNumber(latitude);
    const normalizedLongitude = normalizeNumber(longitude);
    const normalizedExpenseAmount = normalizeNumber(expense_amount) ?? 0;
    const normalizedVisitDate = normalizeDate(visit_date);
    const normalizedNextActionDate = normalizeDate(next_action_date);
    const normalizedProjectId = normalizeNumber(project_id);
    const serializedPayload = serializeFormPayload(form_payload);

    if (!client_name || !client_name.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El cliente es obligatorio' });
    }
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
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);
    await applyAuditContext(connection, req);

    const [result] = await connection.execute(
      `INSERT INTO commercial_visits (
         client_name,
         client_contact,
         visit_date,
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_name.toString().trim(),
        client_contact ? client_contact.toString().trim() : null,
        normalizedVisitDate,
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

    const [rows] = await connection.execute(`${COMMERCIAL_VISIT_SELECT} WHERE cv.id = ?`, [result.insertId]);
    const visitRow = mapVisitRow(rows[0]);
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
    await ensureCommercialVisitsTable(connection);
    await ensureCommercialOpportunitiesTable(connection);

    const [existingRows] = await connection.execute('SELECT * FROM commercial_visits WHERE id = ? LIMIT 1', [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Visita comercial no encontrada' });
    }

    const existing = existingRows[0];
    const nextStatus = req.body.status == null ? existing.status : normalizeStatus(req.body.status);
    const nextVisitDate = req.body.visit_date == null ? existing.visit_date : normalizeDate(req.body.visit_date);
    const nextLatitude = req.body.latitude == null ? normalizeNumber(existing.latitude) : normalizeNumber(req.body.latitude);
    const nextLongitude = req.body.longitude == null ? normalizeNumber(existing.longitude) : normalizeNumber(req.body.longitude);
    const nextActionDate = req.body.next_action_date == null ? normalizeDate(existing.next_action_date) : normalizeDate(req.body.next_action_date);

    if (nextStatus === null) {
      return res.status(400).json({ success: false, message: 'Estado comercial no válido' });
    }
    if (!nextVisitDate) {
      return res.status(400).json({ success: false, message: 'La fecha de visita es obligatoria' });
    }
    if (nextLatitude === null || nextLongitude === null) {
      return res.status(400).json({ success: false, message: 'La visita debe incluir latitud y longitud' });
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_visits
       SET client_name = ?,
           client_contact = ?,
           visit_date = ?,
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
        (req.body.client_name ?? existing.client_name).toString().trim(),
        req.body.client_contact == null ? existing.client_contact : (req.body.client_contact?.toString().trim() || null),
        nextVisitDate,
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

    const [rows] = await connection.execute(`${COMMERCIAL_VISIT_SELECT} WHERE cv.id = ?`, [id]);
    const visitRow = mapVisitRow(rows[0]);
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

const createCommercialOpportunity = async (req, res) => {
  let connection;
  try {
    const {
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

    if (!client_name || !client_name.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El cliente es obligatorio para la oportunidad' });
    }
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
      const [visitRows] = await connection.execute('SELECT id FROM commercial_visits WHERE id = ? LIMIT 1', [normalizedSourceVisitId]);
      if (visitRows.length === 0) {
        return res.status(400).json({ success: false, message: 'La visita comercial vinculada no existe' });
      }
    }

    await applyAuditContext(connection, req);
    const [result] = await connection.execute(
      `INSERT INTO commercial_opportunities (
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        client_name.toString().trim(),
        contact_name ? contact_name.toString().trim() : null,
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
    if (!(req.body.client_name ?? existing.client_name)?.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El cliente es obligatorio para la oportunidad' });
    }
    if (!(req.body.opportunity_name ?? existing.opportunity_name)?.toString().trim()) {
      return res.status(400).json({ success: false, message: 'El nombre de la oportunidad es obligatorio' });
    }

    if (nextSourceVisitId !== null) {
      const [visitRows] = await connection.execute('SELECT id FROM commercial_visits WHERE id = ? LIMIT 1', [nextSourceVisitId]);
      if (visitRows.length === 0) {
        return res.status(400).json({ success: false, message: 'La visita comercial vinculada no existe' });
      }
    }

    await applyAuditContext(connection, req);
    await connection.execute(
      `UPDATE commercial_opportunities
       SET client_name = ?,
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
        (req.body.client_name ?? existing.client_name).toString().trim(),
        req.body.contact_name == null ? existing.contact_name : (req.body.contact_name?.toString().trim() || null),
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
  createCommercialFormTemplate,
  createCommercialVisit,
  updateCommercialFormTemplate,
  updateCommercialVisit,
  createCommercialOpportunity,
  updateCommercialOpportunity,
  ensureCommercialSchema,
};
