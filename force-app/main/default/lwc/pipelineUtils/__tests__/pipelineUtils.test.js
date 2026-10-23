import {
    buildStageSummary,
    computeKpis,
    daysBetween,
    decorateDeal,
    filterDeals,
    getPeriodRange,
    reduceErrors,
    sortDeals,
    timeAgo,
    toCsv
} from 'c/pipelineUtils';

const ctx = { today: '2026-10-22', highValueThreshold: 100000 };

const raw = (overrides) => ({
    id: overrides.id || 'x',
    name: 'Deal',
    accountName: 'Acme',
    ownerId: 'u1',
    ownerName: 'Maya Patel',
    stageName: 'Qualification',
    amount: 10000,
    probability: 10,
    closeDate: '2026-12-01',
    nextStep: 'Call',
    isClosed: false,
    isWon: false,
    healthLevel: 'healthy',
    healthScore: 100,
    riskFlags: [],
    ...overrides
});

const deals = [
    raw({ id: 'a', name: 'Big overdue', amount: 250000, probability: 50, closeDate: '2026-10-01', healthLevel: 'risk' }),
    raw({ id: 'b', name: 'Closing soon', closeDate: '2026-10-30', ownerId: 'u2', ownerName: 'Diego Alvarez' }),
    raw({ id: 'c', name: 'No next step', nextStep: null, closeDate: '2027-01-15', stageName: 'Prospecting' }),
    raw({ id: 'd', name: 'Won deal', isClosed: true, isWon: true, stageName: 'Closed Won', amount: 40000 }),
    raw({ id: 'e', name: 'Lost deal', isClosed: true, isWon: false, stageName: 'Closed Lost', amount: 5000 })
].map((d) => decorateDeal(d, ctx));

const ids = (list) => list.map((d) => d.id);

describe('dates', () => {
    it('counts days between ISO dates', () => {
        expect(daysBetween('2026-10-22', '2026-10-30')).toBe(8);
        expect(daysBetween('2026-10-22', '2026-10-01')).toBe(-21);
        expect(daysBetween('2026-10-22', null)).toBeNull();
    });

    it('builds month and quarter ranges, including year rollover', () => {
        expect(getPeriodRange('thisMonth', '2026-10-22')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
        expect(getPeriodRange('nextMonth', '2026-12-05')).toEqual({ start: '2027-01-01', end: '2027-01-31' });
        expect(getPeriodRange('thisQuarter', '2026-10-22')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
        expect(getPeriodRange('nextQuarter', '2026-10-22')).toEqual({ start: '2027-01-01', end: '2027-03-31' });
        expect(getPeriodRange('all', '2026-10-22')).toBeNull();
    });
});

describe('decorateDeal', () => {
    it('derives overdue, high value, weighted amount and labels', () => {
        const d = deals[0];
        expect(d.isOverdue).toBe(true);
        expect(d.isHighValue).toBe(true);
        expect(d.isAtRisk).toBe(true);
        expect(d.weightedAmount).toBe(125000);
        expect(d.closeLabel).toBe('21d overdue');
        expect(d.closeDateClass).toBe('slds-text-color_error');
    });

    it('does not flag closed deals as overdue or at risk', () => {
        const won = decorateDeal(raw({ isClosed: true, isWon: true, closeDate: '2026-10-01', healthLevel: 'risk' }), ctx);
        expect(won.isOverdue).toBe(false);
        expect(won.isAtRisk).toBe(false);
        expect(won.closeLabel).toBe('');
    });
});

describe('filterDeals', () => {
    it('searches across name, account, owner and next step (all terms must match)', () => {
        expect(ids(filterDeals(deals, { search: 'diego' }, ctx))).toEqual(['b']);
        expect(ids(filterDeals(deals, { search: 'acme overdue' }, ctx))).toEqual(['a']);
    });

    it('filters by owner, status and stage', () => {
        expect(ids(filterDeals(deals, { ownerId: 'u2' }, ctx))).toEqual(['b']);
        expect(ids(filterDeals(deals, { status: 'open' }, ctx))).toEqual(['a', 'b', 'c']);
        expect(ids(filterDeals(deals, { status: 'won' }, ctx))).toEqual(['d']);
        expect(ids(filterDeals(deals, { status: 'lost' }, ctx))).toEqual(['e']);
        expect(ids(filterDeals(deals, { stage: 'Prospecting' }, ctx))).toEqual(['c']);
    });

    it('filters by close period and quick filters', () => {
        expect(ids(filterDeals(deals, { status: 'open', period: 'overdue' }, ctx))).toEqual(['a']);
        expect(ids(filterDeals(deals, { status: 'open', period: 'thisMonth' }, ctx))).toEqual(['a', 'b']);
        expect(ids(filterDeals(deals, { quick: ['closingSoon'] }, ctx))).toEqual(['b']);
        expect(ids(filterDeals(deals, { quick: ['noNextStep'] }, ctx))).toEqual(['c']);
        expect(ids(filterDeals(deals, { quick: ['atRisk', 'highValue'] }, ctx))).toEqual(['a']);
    });

    it('treats "all" and empty values as no filter', () => {
        expect(filterDeals(deals, { ownerId: 'all', stage: 'all', status: 'all', period: 'all', quick: [] }, ctx)).toHaveLength(5);
    });
});

describe('computeKpis', () => {
    it('summarises open, risk, won and win rate', () => {
        const k = computeKpis(deals, ctx);
        expect(k.openCount).toBe(3);
        expect(k.openAmount).toBe(270000);
        expect(k.atRiskCount).toBe(1);
        expect(k.overdueAmount).toBe(250000);
        expect(k.closingMonthCount).toBe(2);
        expect(k.highValueCount).toBe(1);
        expect(k.wonAmount).toBe(40000);
        expect(k.winRate).toBe(50);
    });

    it('returns a null win rate when nothing has closed', () => {
        expect(computeKpis(deals.slice(0, 3), ctx).winRate).toBeNull();
    });
});

describe('buildStageSummary', () => {
    it('only includes open stages and scales bars to the biggest stage', () => {
        const stages = [
            { value: 'Prospecting', label: 'Prospecting', isClosed: false },
            { value: 'Qualification', label: 'Qualification', isClosed: false },
            { value: 'Closed Won', label: 'Closed Won', isClosed: true }
        ];
        const summary = buildStageSummary(deals, stages);
        expect(summary.map((s) => s.value)).toEqual(['Prospecting', 'Qualification']);
        expect(summary[1]).toMatchObject({ count: 2, amount: 260000, widthPct: 100 });
        expect(summary[0].widthPct).toBe(4);
    });
});

describe('sortDeals', () => {
    it('sorts both directions and keeps empty values last', () => {
        const list = [{ v: 2 }, { v: null }, { v: 1 }, { v: 3 }];
        expect(sortDeals(list, 'v', 'asc').map((d) => d.v)).toEqual([1, 2, 3, null]);
        expect(sortDeals(list, 'v', 'desc').map((d) => d.v)).toEqual([3, 2, 1, null]);
    });
});

describe('misc helpers', () => {
    it('escapes CSV values', () => {
        const csv = toCsv([decorateDeal(raw({ name: 'Acme, "Phase 2"' }), ctx)]);
        expect(csv.split('\n')[1].startsWith('"Acme, ""Phase 2"""')).toBe(true);
    });

    it('formats relative time', () => {
        const now = 1_000_000_000;
        expect(timeAgo(now - 10_000, now)).toBe('just now');
        expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
        expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    });

    it('reduces Apex and UI API errors to a message', () => {
        expect(reduceErrors({ body: { message: 'Apex failed' } })).toBe('Apex failed');
        expect(
            reduceErrors({ body: { output: { errors: [{ message: 'Validation rule' }], fieldErrors: {} } } })
        ).toBe('Validation rule');
        expect(reduceErrors(new Error('JS error'))).toBe('JS error');
    });
});
