const {
  CURRENT_TERMS_VERSION,
  getCurrentTermsPayload,
} = require('../src/config/appTerms');

describe('appTerms config', () => {
  it('exposes current version and sections', () => {
    expect(CURRENT_TERMS_VERSION).toBe('2.0');
    const payload = getCurrentTermsPayload();
    expect(payload.version).toBe('2.0');
    expect(Array.isArray(payload.sections)).toBe(true);
    expect(payload.sections.length).toBeGreaterThan(0);
    expect(payload.company?.legalName).toMatch(/SKALER/i);
    expect(payload.company?.nit).toBeTruthy();
    expect(payload.sections[0].body).toMatch(/1581/);
  });
});
