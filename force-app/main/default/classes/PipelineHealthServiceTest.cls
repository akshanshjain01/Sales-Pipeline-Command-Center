@IsTest
private class PipelineHealthServiceTest {
    private static final Date TODAY = Date.newInstance(2026, 10, 22);

    // Read-only fields (PushCount, LastActivityDate, HasOverdueTask...) can only be set through JSON.
    private static Opportunity build(Map<String, Object> fields) {
        Map<String, Object> base = new Map<String, Object>{
            'attributes' => new Map<String, Object>{ 'type' => 'Opportunity' },
            'IsClosed' => false,
            'IsWon' => false,
            'Amount' => 50000,
            'Probability' => 75,
            'CloseDate' => '2026-12-15',
            'NextStep' => 'Exec sponsor meeting',
            'LastActivityDate' => '2026-10-20',
            'LastStageChangeDate' => '2026-10-10T10:00:00.000+0000',
            'CreatedDate' => '2026-09-01T10:00:00.000+0000',
            'PushCount' => 0,
            'HasOverdueTask' => false
        };
        base.putAll(fields);
        return (Opportunity) JSON.deserialize(JSON.serialize(base), Opportunity.class);
    }

    private static Set<String> codes(PipelineHealthService.Assessment a) {
        Set<String> result = new Set<String>();
        for (PipelineHealthService.RiskFlag f : a.flags) {
            result.add(f.code);
        }
        return result;
    }

    @IsTest
    static void healthyDealScoresFull() {
        PipelineHealthService.Assessment a = PipelineHealthService.assess(build(new Map<String, Object>()), 14, TODAY);
        Assert.areEqual(100, a.score);
        Assert.areEqual(PipelineHealthService.LEVEL_HEALTHY, a.level);
        Assert.isTrue(a.flags.isEmpty());
        Assert.areEqual(12, a.daysInStage);
        Assert.areEqual(2, a.daysSinceActivity);
    }

    @IsTest
    static void everyRiskStacks() {
        Opportunity o = build(
            new Map<String, Object>{
                'CloseDate' => '2026-10-01',
                'NextStep' => null,
                'Amount' => null,
                'LastActivityDate' => '2026-08-01',
                'LastStageChangeDate' => '2026-07-01T10:00:00.000+0000',
                'PushCount' => 3,
                'HasOverdueTask' => true
            }
        );
        PipelineHealthService.Assessment a = PipelineHealthService.assess(o, 14, TODAY);
        Assert.areEqual(
            new Set<String>{ 'OVERDUE', 'STALE', 'STUCK', 'SLIPPING', 'OVERDUE_TASK', 'NO_NEXT_STEP', 'NO_AMOUNT' },
            codes(a)
        );
        Assert.areEqual(0, a.score, 'Score never goes below zero');
        Assert.areEqual(PipelineHealthService.LEVEL_RISK, a.level);
    }

    @IsTest
    static void earlyStageClosingSoonAndNoActivity() {
        Opportunity o = build(
            new Map<String, Object>{ 'CloseDate' => '2026-11-01', 'Probability' => 20, 'LastActivityDate' => null }
        );
        PipelineHealthService.Assessment a = PipelineHealthService.assess(o, 14, TODAY);
        Assert.areEqual(new Set<String>{ 'EARLY_STAGE_CLOSING', 'NO_ACTIVITY' }, codes(a));
        Assert.areEqual(65, a.score);
        Assert.areEqual(PipelineHealthService.LEVEL_WATCH, a.level);
    }

    @IsTest
    static void closedDealsAreNotScoredForRisk() {
        PipelineHealthService.Assessment won = PipelineHealthService.assess(
            build(new Map<String, Object>{ 'IsClosed' => true, 'IsWon' => true, 'CloseDate' => '2026-01-01' }),
            14,
            TODAY
        );
        Assert.areEqual(PipelineHealthService.LEVEL_CLOSED, won.level);
        Assert.areEqual(100, won.score);
        Assert.isTrue(won.flags.isEmpty());
    }

    @IsTest
    static void invalidStaleDaysFallsBackToDefault() {
        Opportunity o = build(new Map<String, Object>{ 'LastActivityDate' => '2026-10-01' }); // 21 days ago
        Assert.isTrue(codes(PipelineHealthService.assess(o, 0, TODAY)).contains('STALE'));
        Assert.isFalse(codes(PipelineHealthService.assess(o, 30, TODAY)).contains('STALE'));
    }
}
