const {
  maxFailedAttempts,
  lockMinutes,
  isWebPasswordLoginEnabled,
} = require('../src/modules/auth/auth.login.security.service');

describe('auth login security config', () => {
  it('exposes sane defaults', () => {
    expect(maxFailedAttempts()).toBeGreaterThan(0);
    expect(lockMinutes()).toBeGreaterThan(0);
    expect(typeof isWebPasswordLoginEnabled()).toBe('boolean');
  });
});
