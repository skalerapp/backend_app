const getRequestIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 45);
  }

  const candidate = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
  return candidate ? candidate.toString().trim().slice(0, 45) : null;
};

const applyAuditContext = async (connection, req) => {
  const userId = Number(req.user?.id);
  const normalizedUserId = Number.isFinite(userId) && userId > 0 ? userId : null;
  const ipAddress = getRequestIp(req);

  await connection.query('SET @audit_user_id = ?, @audit_ip_address = ?', [normalizedUserId, ipAddress]);
};

module.exports = {
  applyAuditContext,
};
