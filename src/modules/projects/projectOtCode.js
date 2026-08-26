const parseOtNumericSuffix = (otCode) => {
  const match = String(otCode || '').trim().match(/^OT(\d+)$/i);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const formatOtCode = (numericSuffix) => `OT${numericSuffix}`;

const normalizeOtCodeInput = (raw) => {
  const trimmed = String(raw || '').trim().toUpperCase();
  if (!trimmed) return null;

  const parsed = parseOtNumericSuffix(trimmed);
  if (parsed == null) return null;

  return formatOtCode(parsed);
};

const resolveNextOtNumericSuffix = async (connection) => {
  const [rows] = await connection.execute(
    "SELECT ot_code FROM projects WHERE ot_code IS NOT NULL AND TRIM(ot_code) <> ''",
  );

  let maxSuffix = 0;
  for (const row of rows) {
    const parsed = parseOtNumericSuffix(row.ot_code);
    if (parsed != null && parsed > maxSuffix) {
      maxSuffix = parsed;
    }
  }

  if (maxSuffix > 0) {
    return maxSuffix + 1;
  }

  const [statusRows] = await connection.execute("SHOW TABLE STATUS LIKE 'projects'");
  const nextId = Number(statusRows?.[0]?.Auto_increment || 1);
  return Number.isFinite(nextId) && nextId > 0 ? nextId : 1;
};

const resolveNextOtCode = async (connection) => formatOtCode(await resolveNextOtNumericSuffix(connection));

module.exports = {
  parseOtNumericSuffix,
  formatOtCode,
  normalizeOtCodeInput,
  resolveNextOtCode,
  resolveNextOtNumericSuffix,
};
