const { normalizeRole } = require('../../middleware/auth.middleware');

const FULL_COMMERCIAL_VISIBILITY_ROLES = new Set(['super_admin', 'administrative', 'gerencial']);

const canViewAllCommercialData = (roleValue) => FULL_COMMERCIAL_VISIBILITY_ROLES.has(normalizeRole(roleValue));

const isCommercialRole = (roleValue) => normalizeRole(roleValue) === 'commercial';

const buildVisitOwnerFilter = (roleValue, userId, alias = 'cv') => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue) || !userId) {
    return { clause: null, params: [] };
  }

  return {
    clause: `(${alias}.commercial_id = ? OR ${alias}.created_by = ?)`,
    params: [userId, userId],
  };
};

const buildQuotationOwnerFilter = (roleValue, userId, alias = 'cq') => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue) || !userId) {
    return { clause: null, params: [] };
  }

  return {
    clause: `${alias}.created_by = ?`,
    params: [userId],
  };
};

const buildOpportunityOwnerFilter = (roleValue, userId, alias = 'co') => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue) || !userId) {
    return { clause: null, params: [] };
  }

  return {
    clause: `(${alias}.owner_user_id = ? OR ${alias}.created_by = ?)`,
    params: [userId, userId],
  };
};

const buildCommercialProjectVisibilityFilter = (roleValue, userId, projectAlias = 'p') => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue) || !userId) {
    return { clause: null, params: [] };
  }

  return {
    clause: `(
      EXISTS (
        SELECT 1
        FROM commercial_quotations cq
        WHERE cq.project_id = ${projectAlias}.id
          AND cq.created_by = ?
      )
      OR EXISTS (
        SELECT 1
        FROM commercial_visits cv
        WHERE cv.project_id = ${projectAlias}.id
          AND (cv.commercial_id = ? OR cv.created_by = ?)
      )
      OR EXISTS (
        SELECT 1
        FROM commercial_opportunities co
        WHERE co.project_id = ${projectAlias}.id
          AND (co.owner_user_id = ? OR co.created_by = ?)
      )
    )`,
    params: [userId, userId, userId, userId, userId],
  };
};

const appendSqlFilter = (existingWhereClause, filter) => {
  if (!filter?.clause) {
    return {
      whereClause: existingWhereClause || '',
      params: [],
    };
  }

  const trimmed = (existingWhereClause || '').trim();
  if (!trimmed) {
    return {
      whereClause: `WHERE ${filter.clause}`,
      params: [...filter.params],
    };
  }

  if (trimmed.toUpperCase().startsWith('WHERE')) {
    return {
      whereClause: `${trimmed} AND ${filter.clause}`,
      params: [...filter.params],
    };
  }

  return {
    whereClause: `WHERE ${filter.clause}`,
    params: [...filter.params],
  };
};

const pushFilter = (filters, params, filter) => {
  if (!filter?.clause) return;
  filters.push(filter.clause);
  params.push(...filter.params);
};

const ownsCommercialVisit = (visitRow, roleValue, userId) => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue)) {
    return true;
  }
  if (!userId || !visitRow) return false;
  return Number(visitRow.commercial_id) === Number(userId)
    || Number(visitRow.created_by) === Number(userId);
};

const ownsCommercialQuotation = (quotationRow, roleValue, userId) => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue)) {
    return true;
  }
  if (!userId || !quotationRow) return false;
  return Number(quotationRow.created_by) === Number(userId);
};

const ownsCommercialOpportunity = (opportunityRow, roleValue, userId) => {
  if (canViewAllCommercialData(roleValue) || !isCommercialRole(roleValue)) {
    return true;
  }
  if (!userId || !opportunityRow) return false;
  return Number(opportunityRow.owner_user_id) === Number(userId)
    || Number(opportunityRow.created_by) === Number(userId);
};

const canAccessProjectAsCommercial = async ({ connection, userId, projectId }) => {
  const [rows] = await connection.execute(
    `SELECT p.id
     FROM projects p
     WHERE p.id = ?
       AND (
         EXISTS (
           SELECT 1
           FROM commercial_quotations cq
           WHERE cq.project_id = p.id
             AND cq.created_by = ?
         )
         OR EXISTS (
           SELECT 1
           FROM commercial_visits cv
           WHERE cv.project_id = p.id
             AND (cv.commercial_id = ? OR cv.created_by = ?)
         )
         OR EXISTS (
           SELECT 1
           FROM commercial_opportunities co
           WHERE co.project_id = p.id
             AND (co.owner_user_id = ? OR co.created_by = ?)
         )
       )
     LIMIT 1`,
    [projectId, userId, userId, userId, userId, userId],
  );

  return rows.length > 0;
};

module.exports = {
  FULL_COMMERCIAL_VISIBILITY_ROLES,
  canViewAllCommercialData,
  isCommercialRole,
  buildVisitOwnerFilter,
  buildQuotationOwnerFilter,
  buildOpportunityOwnerFilter,
  buildCommercialProjectVisibilityFilter,
  appendSqlFilter,
  pushFilter,
  ownsCommercialVisit,
  ownsCommercialQuotation,
  ownsCommercialOpportunity,
  canAccessProjectAsCommercial,
};
