const { resolveStockDelta, isFleetAssetLike } = require('../src/modules/warehouse/warehouse.service');

describe('warehouse stock helpers', () => {
  it('increases stock on intake and return movements', () => {
    expect(resolveStockDelta('inspection', '3')).toBe(3);
    expect(resolveStockDelta('return', 2)).toBe(2);
  });

  it('decreases stock on outbound movements', () => {
    expect(resolveStockDelta('delivery', '1')).toBe(-1);
    expect(resolveStockDelta('assignment', 4)).toBe(-4);
  });

  it('ignores fleet assets and neutral movement types', () => {
    expect(resolveStockDelta('transfer', '1')).toBeNull();
    expect(resolveStockDelta('maintenance', '1')).toBeNull();
    expect(isFleetAssetLike({ vehicle_plate: 'ABC123' })).toBe(true);
  });
});
