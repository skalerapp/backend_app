const {
  parseOtNumericSuffix,
  formatOtCode,
  normalizeOtCodeInput,
} = require('../src/modules/projects/projectOtCode');

describe('projectOtCode', () => {
  it('parses OT numeric suffix', () => {
    expect(parseOtNumericSuffix('OT1533')).toBe(1533);
    expect(parseOtNumericSuffix('ot1532')).toBe(1532);
    expect(parseOtNumericSuffix('OT-1533')).toBeNull();
    expect(parseOtNumericSuffix('OTL-260826-1646')).toBeNull();
  });

  it('formats OT code from numeric suffix', () => {
    expect(formatOtCode(1534)).toBe('OT1534');
  });

  it('normalizes user OT input', () => {
    expect(normalizeOtCodeInput(' ot1534 ')).toBe('OT1534');
    expect(normalizeOtCodeInput('OT1534')).toBe('OT1534');
    expect(normalizeOtCodeInput('1534')).toBeNull();
  });
});
