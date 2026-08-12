const db = require('../../config/database');
const { withDbConnection } = db;
const { applyAuditContext } = require('../../utils/auditContext');
const { HttpError, sendControllerError } = require('../../utils/httpError');
const {
  ensureFleetShape,
  listFleetUnits,
  getFleetUnitById,
  createFleetUnit,
  updateFleetUnit,
  listMaintenanceRecords,
  createMaintenanceRecord,
  listFleetAlerts,
} = require('./fleet.service');

const listUnits = async (req, res) => {
  try {
    const { q, city, limit } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      return listFleetUnits(connection, { query: q, city, limit });
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'No fue posible cargar el parque vehicular');
  }
};

const getUnit = async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ success: false, message: 'ID de vehículo inválido' });
    }

    const row = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      return getFleetUnitById(connection, assetId);
    });

    if (!row) {
      return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    sendControllerError(res, error, 'No fue posible cargar el detalle del vehículo');
  }
};

const createUnit = async (req, res) => {
  try {
    const row = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      await applyAuditContext(connection, req);
      return createFleetUnit(connection, req.body || {});
    });

    res.status(201).json({ success: true, data: row });
  } catch (error) {
    if (error.message && !error.status) {
      return res.status(400).json({ success: false, message: error.message });
    }
    sendControllerError(res, error, 'No fue posible registrar el vehículo');
  }
};

const updateUnit = async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ success: false, message: 'ID de vehículo inválido' });
    }

    const row = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      await applyAuditContext(connection, req);
      return updateFleetUnit(connection, assetId, req.body || {});
    });

    if (!row) {
      return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    if (error.message && !error.status) {
      return res.status(400).json({ success: false, message: error.message });
    }
    sendControllerError(res, error, 'No fue posible actualizar el vehículo');
  }
};

const listMaintenance = async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ success: false, message: 'ID de vehículo inválido' });
    }

    const rows = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      const unit = await getFleetUnitById(connection, assetId);
      if (!unit) {
        throw new HttpError(404, 'Vehículo no encontrado');
      }
      return listMaintenanceRecords(connection, assetId);
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'No fue posible cargar mantenimientos del vehículo');
  }
};

const createMaintenance = async (req, res) => {
  try {
    const assetId = Number(req.params.id);
    if (!Number.isFinite(assetId)) {
      return res.status(400).json({ success: false, message: 'ID de vehículo inválido' });
    }

    const row = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      await applyAuditContext(connection, req);
      const created = await createMaintenanceRecord(
        connection,
        assetId,
        req.body || {},
        req.user?.id ?? null,
      );
      if (!created) {
        throw new HttpError(404, 'Vehículo no encontrado');
      }
      return created;
    });

    res.status(201).json({ success: true, data: row });
  } catch (error) {
    if (error.message && !error.status) {
      return res.status(400).json({ success: false, message: error.message });
    }
    sendControllerError(res, error, 'No fue posible registrar el mantenimiento');
  }
};

const listAlerts = async (req, res) => {
  try {
    const { q, limit } = req.query;
    const rows = await withDbConnection(async (connection) => {
      await ensureFleetShape(connection);
      return listFleetAlerts(connection, { query: q, limit });
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    sendControllerError(res, error, 'No fue posible cargar alertas de flota');
  }
};

module.exports = {
  listUnits,
  getUnit,
  createUnit,
  updateUnit,
  listMaintenance,
  createMaintenance,
  listAlerts,
};
