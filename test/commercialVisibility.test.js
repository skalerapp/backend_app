const {
  buildCommercialProjectVisibilityFilter,
  buildQuotationOwnerFilter,
  buildVisitOwnerFilter,
  canViewAllCommercialData,
  isCommercialRole,
} = require('../src/modules/commercial/commercialVisibility.service');

describe('commercialVisibility.service', () => {
  it('allows full visibility only for administrative roles', () => {
    expect(canViewAllCommercialData('super_admin')).toBe(true);
    expect(canViewAllCommercialData('administrative')).toBe(true);
    expect(canViewAllCommercialData('gerencial')).toBe(true);
    expect(canViewAllCommercialData('commercial')).toBe(false);
    expect(canViewAllCommercialData('supervisor')).toBe(false);
  });

  it('scopes commercial projects to linked commercial activity', () => {
    const filter = buildCommercialProjectVisibilityFilter('commercial', 42, 'p');

    expect(filter.clause).toContain('commercial_quotations');
    expect(filter.clause).toContain('commercial_visits');
    expect(filter.clause).toContain('commercial_opportunities');
    expect(filter.params).toEqual([42, 42, 42, 42, 42]);
  });

  it('does not scope projects for commercial full-access roles', () => {
    const filter = buildCommercialProjectVisibilityFilter('gerencial', 42, 'p');
    expect(filter.clause).toBeNull();
    expect(filter.params).toEqual([]);
  });

  it('scopes quotations to created_by for commercial users', () => {
    const filter = buildQuotationOwnerFilter('commercial', 9, 'cq');
    expect(filter.clause).toBe('cq.created_by = ?');
    expect(filter.params).toEqual([9]);
  });

  it('scopes visits to commercial_id or created_by for commercial users', () => {
    const filter = buildVisitOwnerFilter('commercial', 9, 'cv');
    expect(filter.clause).toBe('(cv.commercial_id = ? OR cv.created_by = ?)');
    expect(filter.params).toEqual([9, 9]);
  });

  it('identifies commercial role', () => {
    expect(isCommercialRole('commercial')).toBe(true);
    expect(isCommercialRole('leader')).toBe(false);
  });
});
