/**
 * Scores the health of an open Opportunity and explains why.
 *
 * Each rule removes points from a starting score of 100 and adds a readable
 * flag, so a manager sees both the number and the reason behind it.
 * Rules use only standard fields, so this works in any org without setup.
 */
public with sharing class PipelineHealthService {
    public static final Integer SCORE_AT_RISK = 60;
    public static final Integer SCORE_WATCH = 80;
    public static final Integer DEFAULT_STALE_DAYS = 14;

    public static final String LEVEL_RISK = 'risk';
    public static final String LEVEL_WATCH = 'watch';
    public static final String LEVEL_HEALTHY = 'healthy';
    public static final String LEVEL_CLOSED = 'closed';

    public class RiskFlag {
        @AuraEnabled
        public String code;
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String severity; // high | medium | low
        @AuraEnabled
        public Integer penalty;

        public RiskFlag(String code, String label, String severity, Integer penalty) {
            this.code = code;
            this.label = label;
            this.severity = severity;
            this.penalty = penalty;
        }
    }

    public class Assessment {
        @AuraEnabled
        public Integer score;
        @AuraEnabled
        public String level;
        @AuraEnabled
        public List<RiskFlag> flags = new List<RiskFlag>();
        @AuraEnabled
        public Integer daysInStage;
        @AuraEnabled
        public Integer daysSinceActivity;
    }

    public static Assessment assess(Opportunity opp, Integer staleDays, Date today) {
        Integer stale = (staleDays == null || staleDays < 1) ? DEFAULT_STALE_DAYS : staleDays;
        Integer stuckDays = stale * 3;
        Assessment result = new Assessment();
        result.daysInStage = daysInStage(opp, today);
        result.daysSinceActivity = opp.LastActivityDate == null ? null : opp.LastActivityDate.daysBetween(today);

        if (opp.IsClosed == true) {
            result.score = opp.IsWon == true ? 100 : 0;
            result.level = LEVEL_CLOSED;
            return result;
        }

        List<RiskFlag> flags = result.flags;
        Integer daysToClose = opp.CloseDate == null ? null : today.daysBetween(opp.CloseDate);
        Decimal probability = opp.Probability == null ? 0 : opp.Probability;

        if (daysToClose != null && daysToClose < 0) {
            flags.add(new RiskFlag('OVERDUE', 'Close date passed ' + Math.abs(daysToClose) + 'd ago', 'high', 30));
        } else if (daysToClose != null && daysToClose <= 30 && probability < 50) {
            flags.add(
                new RiskFlag(
                    'EARLY_STAGE_CLOSING',
                    'Closes in ' + daysToClose + 'd at only ' + probability.intValue() + '%',
                    'high',
                    20
                )
            );
        }

        if (result.daysSinceActivity == null) {
            flags.add(new RiskFlag('NO_ACTIVITY', 'No activity logged', 'medium', 15));
        } else if (result.daysSinceActivity > stale) {
            flags.add(new RiskFlag('STALE', 'No activity in ' + result.daysSinceActivity + 'd', 'medium', 20));
        }

        if (result.daysInStage != null && result.daysInStage > stuckDays) {
            flags.add(new RiskFlag('STUCK', result.daysInStage + 'd in current stage', 'medium', 15));
        }

        if (opp.PushCount != null && opp.PushCount >= 2) {
            flags.add(new RiskFlag('SLIPPING', 'Close date pushed ' + opp.PushCount + ' times', 'medium', 15));
        }

        if (opp.HasOverdueTask == true) {
            flags.add(new RiskFlag('OVERDUE_TASK', 'Overdue follow-up task', 'low', 10));
        }

        if (String.isBlank(opp.NextStep)) {
            flags.add(new RiskFlag('NO_NEXT_STEP', 'No next step defined', 'low', 10));
        }

        if (opp.Amount == null || opp.Amount == 0) {
            flags.add(new RiskFlag('NO_AMOUNT', 'Amount missing', 'low', 5));
        }

        Integer penalty = 0;
        for (RiskFlag flag : flags) {
            penalty += flag.penalty;
        }
        result.score = Math.max(0, 100 - penalty);
        result.level = result.score < SCORE_AT_RISK
            ? LEVEL_RISK
            : (result.score < SCORE_WATCH ? LEVEL_WATCH : LEVEL_HEALTHY);
        return result;
    }

    private static Integer daysInStage(Opportunity opp, Date today) {
        Datetime since = opp.LastStageChangeDate != null ? opp.LastStageChangeDate : opp.CreatedDate;
        return since == null ? null : since.date().daysBetween(today);
    }
}
