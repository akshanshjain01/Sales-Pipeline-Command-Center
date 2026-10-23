/**
 * Server side of the Pipeline Command Center LWC.
 *
 * - One call loads the whole working set (open deals + deals closed this
 *   fiscal quarter) so filtering, search and KPIs run instantly in the browser.
 * - getChanges returns only the deals that changed, so live updates merge in
 *   place instead of reloading hundreds of rows.
 * - All queries and DML run in user mode: sharing, CRUD and FLS are enforced.
 */
public with sharing class PipelineCommandCenterController {
    @TestVisible
    private static final Integer MAX_RECORDS = 2000;
    private static final Integer MAX_CHANGES = 500;
    private static final Integer MAX_NOTE_LENGTH = 5000;

    public static final String SCOPE_TEAM = 'TEAM';
    public static final String SCOPE_MINE = 'MINE';
    public static final String SCOPE_ALL = 'ALL';

    private static final String DEAL_FIELDS =
        'Id, Name, AccountId, Account.Name, OwnerId, Owner.Name, Owner.SmallPhotoUrl, StageName, Amount, ' +
        'Probability, CloseDate, NextStep, Type, LeadSource, ForecastCategoryName, IsClosed, IsWon, ' +
        'LastActivityDate, LastStageChangeDate, PushCount, HasOverdueTask, HasOpenActivity, CreatedDate, ' +
        'LastModifiedDate, LastModifiedById, LastModifiedBy.Name';

    // Working set: everything still open, plus what closed this quarter (for won / win-rate KPIs).
    private static final String WORKING_SET_FILTER = '(IsClosed = false OR CloseDate = THIS_FISCAL_QUARTER)';

    // ---------------------------------------------------------------- DTOs

    public class PipelineData {
        @AuraEnabled
        public List<DealDto> deals;
        @AuraEnabled
        public List<StageDto> stages;
        @AuraEnabled
        public Boolean truncated;
        @AuraEnabled
        public Integer maxRecords;
        @AuraEnabled
        public Boolean hasTeam;
        @AuraEnabled
        public Id currentUserId;
        @AuraEnabled
        public Datetime serverTime;
    }

    public class ChangeSet {
        @AuraEnabled
        public List<DealDto> deals;
        @AuraEnabled
        public Datetime serverTime;
    }

    public class StageDto {
        @AuraEnabled
        public String label;
        @AuraEnabled
        public String value;
        @AuraEnabled
        public Integer sortOrder;
        @AuraEnabled
        public Decimal probability;
        @AuraEnabled
        public Boolean isClosed;
        @AuraEnabled
        public Boolean isWon;
    }

    public class DealDto {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String name;
        @AuraEnabled
        public Id accountId;
        @AuraEnabled
        public String accountName;
        @AuraEnabled
        public Id ownerId;
        @AuraEnabled
        public String ownerName;
        @AuraEnabled
        public String ownerPhotoUrl;
        @AuraEnabled
        public String stageName;
        @AuraEnabled
        public Decimal amount;
        @AuraEnabled
        public Decimal probability;
        @AuraEnabled
        public Date closeDate;
        @AuraEnabled
        public String nextStep;
        @AuraEnabled
        public String type;
        @AuraEnabled
        public String leadSource;
        @AuraEnabled
        public String forecastCategory;
        @AuraEnabled
        public Boolean isClosed;
        @AuraEnabled
        public Boolean isWon;
        @AuraEnabled
        public Date lastActivityDate;
        @AuraEnabled
        public Integer daysInStage;
        @AuraEnabled
        public Integer daysSinceActivity;
        @AuraEnabled
        public Integer pushCount;
        @AuraEnabled
        public Boolean hasOverdueTask;
        @AuraEnabled
        public Datetime lastModifiedDate;
        @AuraEnabled
        public Id lastModifiedById;
        @AuraEnabled
        public String lastModifiedByName;
        @AuraEnabled
        public Integer healthScore;
        @AuraEnabled
        public String healthLevel;
        @AuraEnabled
        public List<PipelineHealthService.RiskFlag> riskFlags;
        @AuraEnabled
        public Boolean inScope = true;
    }

    public class DealInsights {
        @AuraEnabled
        public List<FeedPost> posts = new List<FeedPost>();
        @AuraEnabled
        public List<TaskRow> tasks = new List<TaskRow>();
    }

    public class FeedPost {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String body;
        @AuraEnabled
        public String authorName;
        @AuraEnabled
        public Datetime createdDate;
    }

    public class TaskRow {
        @AuraEnabled
        public Id id;
        @AuraEnabled
        public String subject;
        @AuraEnabled
        public Date dueDate;
        @AuraEnabled
        public String status;
        @AuraEnabled
        public String priority;
        @AuraEnabled
        public String ownerName;
        @AuraEnabled
        public Boolean isClosed;
        @AuraEnabled
        public Boolean isOverdue;
    }

    // ---------------------------------------------------------------- API

    /**
     * Loads the full working set for the chosen scope.
     * @param scope TEAM (me + people reporting to me), MINE, or ALL (everything I can see)
     * @param staleDays days without activity before a deal is flagged as stale
     */
    @AuraEnabled
    public static PipelineData getPipeline(String scope, Integer staleDays) {
        try {
            String safeScope = normalizeScope(scope);
            Set<Id> teamIds = teamMemberIds();
            Map<String, Object> binds = new Map<String, Object>{ 'maxRows' => MAX_RECORDS + 1 };
            String whereClause = WORKING_SET_FILTER + ownerFilter(safeScope, teamIds, binds);

            List<Opportunity> rows = queryDeals(whereClause, binds, 'maxRows');
            PipelineData data = new PipelineData();
            data.truncated = rows.size() > MAX_RECORDS;
            if (data.truncated) {
                rows.remove(rows.size() - 1);
            }
            data.deals = toDtos(rows, staleDays);
            data.stages = loadStages();
            data.maxRecords = MAX_RECORDS;
            data.hasTeam = teamIds.size() > 1;
            data.currentUserId = UserInfo.getUserId();
            data.serverTime = Datetime.now();
            return data;
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    /**
     * Returns deals changed since a point in time and/or a list of record ids.
     * Each deal says whether it still belongs in the current scope, so the
     * client can add, update or drop it.
     */
    @AuraEnabled
    public static ChangeSet getChanges(String scope, String sinceIso, List<Id> recordIds, Integer staleDays) {
        try {
            ChangeSet result = new ChangeSet();
            result.serverTime = Datetime.now();
            result.deals = new List<DealDto>();

            Datetime since = parseDatetime(sinceIso);
            Set<Id> ids = recordIds == null ? new Set<Id>() : new Set<Id>(recordIds);
            if (since == null && ids.isEmpty()) {
                return result;
            }

            Map<String, Object> binds = new Map<String, Object>{ 'maxRows' => MAX_CHANGES, 'changedIds' => ids };
            List<String> parts = new List<String>();
            if (since != null) {
                binds.put('since', since);
                parts.add('LastModifiedDate > :since');
            }
            if (!ids.isEmpty()) {
                parts.add('Id IN :changedIds');
            }
            List<Opportunity> changed = queryDeals('(' + String.join(parts, ' OR ') + ')', binds, 'maxRows');
            if (changed.isEmpty()) {
                return result;
            }

            // Which of the changed deals still match the working set and scope?
            Set<Id> candidateIds = new Map<Id, Opportunity>(changed).keySet();
            Map<String, Object> scopeBinds = new Map<String, Object>{ 'candidateIds' => candidateIds };
            String scopeWhere =
                'Id IN :candidateIds AND ' +
                WORKING_SET_FILTER +
                ownerFilter(normalizeScope(scope), teamMemberIds(), scopeBinds);
            Set<Id> inScopeIds = new Map<Id, Opportunity>(
                    (List<Opportunity>) Database.queryWithBinds(
                        'SELECT Id FROM Opportunity WHERE ' + scopeWhere,
                        scopeBinds,
                        AccessLevel.USER_MODE
                    )
                )
                .keySet();

            for (DealDto dto : toDtos(changed, staleDays)) {
                dto.inScope = inScopeIds.contains(dto.id);
                result.deals.add(dto);
            }
            return result;
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    /** Recent Chatter posts and tasks for the deal side panel. */
    @AuraEnabled
    public static DealInsights getDealInsights(Id opportunityId) {
        try {
            DealInsights insights = new DealInsights();
            for (FeedItem item : [
                SELECT Id, Body, CreatedBy.Name, CreatedDate
                FROM FeedItem
                WHERE ParentId = :opportunityId AND Type IN ('TextPost', 'LinkPost')
                WITH USER_MODE
                ORDER BY CreatedDate DESC
                LIMIT 5
            ]) {
                FeedPost post = new FeedPost();
                post.id = item.Id;
                post.body = item.Body == null ? '' : item.Body.stripHtmlTags();
                post.authorName = item.CreatedBy.Name;
                post.createdDate = item.CreatedDate;
                insights.posts.add(post);
            }
            Date today = Date.today();
            for (Task t : [
                SELECT Id, Subject, ActivityDate, Status, Priority, Owner.Name, IsClosed
                FROM Task
                WHERE WhatId = :opportunityId
                WITH USER_MODE
                ORDER BY IsClosed ASC, ActivityDate DESC NULLS LAST
                LIMIT 8
            ]) {
                TaskRow row = new TaskRow();
                row.id = t.Id;
                row.subject = t.Subject;
                row.dueDate = t.ActivityDate;
                row.status = t.Status;
                row.priority = t.Priority;
                row.ownerName = t.Owner.Name;
                row.isClosed = t.IsClosed;
                row.isOverdue = !t.IsClosed && t.ActivityDate != null && t.ActivityDate < today;
                insights.tasks.add(row);
            }
            return insights;
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    /**
     * Posts a coaching note to the deal's Chatter feed and @mentions the owner,
     * so the rep gets a notification without the manager leaving the screen.
     */
    @AuraEnabled
    public static void postCoachingNote(Id opportunityId, String message) {
        if (String.isBlank(message)) {
            throw newAuraException('Write a note before posting.');
        }
        if (message.length() > MAX_NOTE_LENGTH) {
            throw newAuraException('Notes are limited to ' + MAX_NOTE_LENGTH + ' characters.');
        }
        try {
            Opportunity opp = [SELECT Id, OwnerId FROM Opportunity WHERE Id = :opportunityId WITH USER_MODE];

            ConnectApi.MessageBodyInput body = new ConnectApi.MessageBodyInput();
            body.messageSegments = new List<ConnectApi.MessageSegmentInput>();
            if (opp.OwnerId != UserInfo.getUserId()) {
                ConnectApi.MentionSegmentInput mention = new ConnectApi.MentionSegmentInput();
                mention.id = opp.OwnerId;
                body.messageSegments.add(mention);
                body.messageSegments.add(textSegment(' '));
            }
            body.messageSegments.add(textSegment(message.trim()));

            ConnectApi.FeedItemInput input = new ConnectApi.FeedItemInput();
            input.subjectId = opp.Id;
            input.feedElementType = ConnectApi.FeedElementType.FeedItem;
            input.body = body;
            ConnectApi.ChatterFeeds.postFeedElement(Network.getNetworkId(), input);
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    /** Assigns a follow-up task to the deal owner. */
    @AuraEnabled
    public static Id createFollowUpTask(
        Id opportunityId,
        String subject,
        String dueDate,
        String priority,
        String comments
    ) {
        if (String.isBlank(subject)) {
            throw newAuraException('Add a subject for the task.');
        }
        try {
            Opportunity opp = [SELECT Id, OwnerId FROM Opportunity WHERE Id = :opportunityId WITH USER_MODE];
            Task t = new Task(
                WhatId = opp.Id,
                OwnerId = opp.OwnerId,
                Subject = subject.trim().left(255),
                ActivityDate = String.isBlank(dueDate) ? Date.today().addDays(2) : Date.valueOf(dueDate),
                Priority = String.isBlank(priority) ? 'Normal' : priority,
                Status = 'Not Started',
                Description = comments
            );
            Database.insert(t, AccessLevel.USER_MODE);
            return t.Id;
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    // ---------------------------------------------------------------- helpers

    @TestVisible
    private static String normalizeScope(String scope) {
        String upper = scope == null ? SCOPE_TEAM : scope.toUpperCase();
        return new Set<String>{ SCOPE_TEAM, SCOPE_MINE, SCOPE_ALL }.contains(upper) ? upper : SCOPE_TEAM;
    }

    /** Current user plus everyone up to three levels below them (via the Manager field). */
    @TestVisible
    private static Set<Id> teamMemberIds() {
        Id me = UserInfo.getUserId();
        Set<Id> ids = new Set<Id>{ me };
        for (User u : [
            SELECT Id
            FROM User
            WHERE IsActive = TRUE AND (ManagerId = :me OR Manager.ManagerId = :me OR Manager.Manager.ManagerId = :me)
            WITH USER_MODE
            LIMIT 500
        ]) {
            ids.add(u.Id);
        }
        return ids;
    }

    private static String ownerFilter(String scope, Set<Id> teamIds, Map<String, Object> binds) {
        if (scope == SCOPE_ALL) {
            return '';
        }
        binds.put('ownerIds', scope == SCOPE_MINE ? new Set<Id>{ UserInfo.getUserId() } : teamIds);
        return ' AND OwnerId IN :ownerIds';
    }

    private static List<Opportunity> queryDeals(String whereClause, Map<String, Object> binds, String limitBind) {
        String soql =
            'SELECT ' +
            DEAL_FIELDS +
            ' FROM Opportunity WHERE ' +
            whereClause +
            ' ORDER BY CloseDate ASC, Amount DESC NULLS LAST LIMIT :' +
            limitBind;
        return (List<Opportunity>) Database.queryWithBinds(soql, binds, AccessLevel.USER_MODE);
    }

    private static List<DealDto> toDtos(List<Opportunity> rows, Integer staleDays) {
        Date today = Date.today();
        List<DealDto> dtos = new List<DealDto>();
        for (Opportunity o : rows) {
            PipelineHealthService.Assessment health = PipelineHealthService.assess(o, staleDays, today);
            DealDto d = new DealDto();
            d.id = o.Id;
            d.name = o.Name;
            d.accountId = o.AccountId;
            d.accountName = o.Account?.Name;
            d.ownerId = o.OwnerId;
            d.ownerName = o.Owner?.Name;
            d.ownerPhotoUrl = o.Owner?.SmallPhotoUrl;
            d.stageName = o.StageName;
            d.amount = o.Amount;
            d.probability = o.Probability;
            d.closeDate = o.CloseDate;
            d.nextStep = o.NextStep;
            d.type = o.Type;
            d.leadSource = o.LeadSource;
            d.forecastCategory = o.ForecastCategoryName;
            d.isClosed = o.IsClosed;
            d.isWon = o.IsWon;
            d.lastActivityDate = o.LastActivityDate;
            d.pushCount = o.PushCount;
            d.hasOverdueTask = o.HasOverdueTask;
            d.lastModifiedDate = o.LastModifiedDate;
            d.lastModifiedById = o.LastModifiedById;
            d.lastModifiedByName = o.LastModifiedBy?.Name;
            d.daysInStage = health.daysInStage;
            d.daysSinceActivity = health.daysSinceActivity;
            d.healthScore = health.score;
            d.healthLevel = health.level;
            d.riskFlags = health.flags;
            dtos.add(d);
        }
        return dtos;
    }

    private static List<StageDto> loadStages() {
        List<StageDto> stages = new List<StageDto>();
        for (OpportunityStage s : [
            SELECT ApiName, MasterLabel, SortOrder, DefaultProbability, IsClosed, IsWon
            FROM OpportunityStage
            WHERE IsActive = TRUE
            WITH USER_MODE
            ORDER BY SortOrder
        ]) {
            StageDto dto = new StageDto();
            dto.label = s.MasterLabel;
            dto.value = s.ApiName;
            dto.sortOrder = s.SortOrder;
            dto.probability = s.DefaultProbability;
            dto.isClosed = s.IsClosed;
            dto.isWon = s.IsWon;
            stages.add(dto);
        }
        return stages;
    }

    @TestVisible
    private static Datetime parseDatetime(String iso) {
        if (String.isBlank(iso)) {
            return null;
        }
        try {
            return (Datetime) JSON.deserialize('"' + iso + '"', Datetime.class);
        } catch (Exception e) {
            throw newAuraException('Invalid timestamp: ' + iso);
        }
    }

    private static ConnectApi.TextSegmentInput textSegment(String text) {
        ConnectApi.TextSegmentInput segment = new ConnectApi.TextSegmentInput();
        segment.text = text;
        return segment;
    }

    private static AuraHandledException newAuraException(String message) {
        AuraHandledException ex = new AuraHandledException(message);
        ex.setMessage(message);
        return ex;
    }

    private static AuraHandledException toAuraException(Exception e) {
        if (e instanceof AuraHandledException) {
            return (AuraHandledException) e;
        }
        String message = e.getMessage();
        if (e instanceof DmlException) {
            message = ((DmlException) e).getDmlMessage(0);
        }
        return newAuraException(message);
    }
}
