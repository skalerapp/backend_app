const { resolveWebBridgeSessionExpiry } = require('../src/modules/auth/auth.session.service');

describe('resolveWebBridgeSessionExpiry', () => {
  it('caps bridge web session at ticket expiry when ticket ends sooner', () => {
    const now = new Date('2026-08-06T17:37:37.000Z');
    const appExpiresAt = new Date('2026-08-07T17:37:37.000Z');
    const ticketExpiresAt = new Date('2026-08-06T18:07:20.000Z');

    const resolved = resolveWebBridgeSessionExpiry({
      now,
      appExpiresAt,
      ticketExpiresAt,
    });

    expect(resolved.toISOString()).toBe(ticketExpiresAt.toISOString());
  });

  it('uses bridge ttl when it is shorter than app and ticket expiry', () => {
    process.env.WEB_BRIDGE_SESSION_EXPIRE = '15m';
    const now = new Date('2026-08-06T17:37:37.000Z');
    const appExpiresAt = new Date('2026-08-07T17:37:37.000Z');
    const ticketExpiresAt = new Date('2026-08-06T19:37:37.000Z');

    const resolved = resolveWebBridgeSessionExpiry({
      now,
      appExpiresAt,
      ticketExpiresAt,
    });

    expect(resolved.toISOString()).toBe('2026-08-06T17:52:37.000Z');
    delete process.env.WEB_BRIDGE_SESSION_EXPIRE;
  });
});
