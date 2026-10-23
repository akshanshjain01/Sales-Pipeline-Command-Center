@IsTest
private class PipelineCommandCenterControllerTest {
    private static final String REP_ALIAS = 'pccrep';
    private static final String OUTSIDER_ALIAS = 'pccout';

    @TestSetup
    static void makeData() {
        Profile standard = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User rep = buildUser(standard.Id, REP_ALIAS, UserInfo.getUserId());
        User outsider = buildUser(standard.Id, OUTSIDER_ALIAS, null);
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert new List<User>{ rep, outsider };
        }

        Account acc = new Account(Name = 'Acme Test');
        insert acc;
        Date today = Date.today();
        insert new List<Opportunity>{
            new Opportunity(
                Name = 'Mine Healthy',
                AccountId = acc.Id,
                StageName = 'Proposal/Price Quote',
                CloseDate = today.addDays(45),
                Amount = 250000,
                NextStep = 'Send proposal'
            ),
            new Opportunity(
                Name = 'Rep Overdue',
                AccountId = acc.Id,
                StageName = 'Qualification',
                CloseDate = today.addDays(-5),
                Amount = 20000,
                OwnerId = rep.Id
            ),
            new Opportunity(
                Name = 'Outsider Deal',
                AccountId = acc.Id,
                StageName = 'Prospecting',
                CloseDate = today.addDays(60),
                Amount = 5000,
                OwnerId = outsider.Id
            ),
            new Opportunity(
                Name = 'Won This Quarter',
                AccountId = acc.Id,
                StageName = 'Closed Won',
                CloseDate = today,
                Amount = 40000
            )
        };
    }

    private static User buildUser(Id profileId, String alias, Id managerId) {
        String unique = alias + String.valueOf(Crypto.getRandomInteger()).replace('-', '') + '@pcc.test';
        return new User(
            ProfileId = profileId,
            LastName = alias,
            Alias = alias,
            Email = unique,
            Username = unique,
            ManagerId = managerId,
            TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US',
            LanguageLocaleKey = 'en_US',
            EmailEncodingKey = 'UTF-8'
        );
    }

    private static Set<String> names(List<PipelineCommandCenterController.DealDto> deals) {
        Set<String> result = new Set<String>();
        for (PipelineCommandCenterController.DealDto d : deals) {
            result.add(d.name);
        }
        return result;
    }

    private static Opportunity opp(String name) {
        return [SELECT Id, OwnerId FROM Opportunity WHERE Name = :name LIMIT 1];
    }

    @IsTest
    static void teamScopeIncludesDirectReportsOnly() {
        Test.startTest();
        PipelineCommandCenterController.PipelineData data = PipelineCommandCenterController.getPipeline('TEAM', 14);
        Test.stopTest();

        Set<String> found = names(data.deals);
        Assert.isTrue(found.contains('Mine Healthy'), 'Own deal should be in team scope');
        Assert.isTrue(found.contains('Rep Overdue'), 'Direct report deal should be in team scope');
        Assert.isTrue(found.contains('Won This Quarter'), 'Deals closed this quarter are part of the working set');
        Assert.isFalse(found.contains('Outsider Deal'), 'Non-team deal must be excluded');
        Assert.isTrue(data.hasTeam, 'Running user has a direct report');
        Assert.isFalse(data.truncated, 'Small data set should not be truncated');
        Assert.isFalse(data.stages.isEmpty(), 'Stages should be returned for the Kanban board');
        Assert.areEqual(UserInfo.getUserId(), data.currentUserId, 'Current user id should be returned');
    }

    @IsTest
    static void mineAndAllScopes() {
        Set<String> mine = names(PipelineCommandCenterController.getPipeline('MINE', 14).deals);
        Set<String> all = names(PipelineCommandCenterController.getPipeline('ALL', 14).deals);

        Assert.isTrue(mine.contains('Mine Healthy'), 'My deal should be in MINE');
        Assert.isFalse(mine.contains('Rep Overdue'), 'Rep deal should not be in MINE');
        Assert.isTrue(all.contains('Outsider Deal'), 'ALL should include every visible deal');
    }

    @IsTest
    static void dealsCarryHealthAssessment() {
        Map<String, PipelineCommandCenterController.DealDto> byName = new Map<String, PipelineCommandCenterController.DealDto>();
        for (PipelineCommandCenterController.DealDto d : PipelineCommandCenterController.getPipeline('ALL', 14).deals) {
            byName.put(d.name, d);
        }
        PipelineCommandCenterController.DealDto overdue = byName.get('Rep Overdue');
        Set<String> codes = new Set<String>();
        for (PipelineHealthService.RiskFlag f : overdue.riskFlags) {
            codes.add(f.code);
        }
        Assert.isTrue(codes.contains('OVERDUE'), 'Past close date should be flagged');
        Assert.isTrue(codes.contains('NO_NEXT_STEP'), 'Missing next step should be flagged');
        Assert.areEqual(PipelineHealthService.LEVEL_CLOSED, byName.get('Won This Quarter').healthLevel);
    }

    @IsTest
    static void getChangesReturnsScopeFlag() {
        Opportunity outsider = opp('Outsider Deal');
        Opportunity mine = opp('Mine Healthy');

        Test.startTest();
        PipelineCommandCenterController.ChangeSet changes = PipelineCommandCenterController.getChanges(
            'TEAM',
            null,
            new List<Id>{ outsider.Id, mine.Id },
            14
        );
        Test.stopTest();

        Assert.areEqual(2, changes.deals.size(), 'Both requested deals should come back');
        for (PipelineCommandCenterController.DealDto d : changes.deals) {
            Assert.areEqual(d.id == mine.Id, d.inScope, 'Only my deal is in TEAM scope: ' + d.name);
        }
        Assert.isNotNull(changes.serverTime, 'Server time is used for the next sync');
    }

    @IsTest
    static void getChangesSinceTimestamp() {
        String since = JSON.serialize(Datetime.now().addMinutes(-10)).remove('"');
        PipelineCommandCenterController.ChangeSet changes = PipelineCommandCenterController.getChanges(
            'ALL',
            since,
            null,
            14
        );
        Assert.areEqual(4, changes.deals.size(), 'All deals were modified in the last 10 minutes');

        PipelineCommandCenterController.ChangeSet none = PipelineCommandCenterController.getChanges(
            'ALL',
            null,
            new List<Id>(),
            14
        );
        Assert.isTrue(none.deals.isEmpty(), 'Nothing requested, nothing returned');
    }

    @IsTest
    static void invalidTimestampThrows() {
        try {
            PipelineCommandCenterController.getChanges('ALL', 'not-a-date', null, 14);
            Assert.fail('Expected an exception');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('Invalid timestamp'), e.getMessage());
        }
    }

    @IsTest
    static void normalizeScopeDefaultsToTeam() {
        Assert.areEqual('TEAM', PipelineCommandCenterController.normalizeScope(null));
        Assert.areEqual('TEAM', PipelineCommandCenterController.normalizeScope('bogus'));
        Assert.areEqual('ALL', PipelineCommandCenterController.normalizeScope('all'));
    }

    @IsTest
    static void createFollowUpTaskAssignsOwner() {
        Opportunity rep = opp('Rep Overdue');
        String due = String.valueOf(Date.today().addDays(3));

        Test.startTest();
        Id taskId = PipelineCommandCenterController.createFollowUpTask(rep.Id, 'Call champion', due, 'High', 'Ask about budget');
        Test.stopTest();

        Task t = [SELECT OwnerId, WhatId, Priority, ActivityDate FROM Task WHERE Id = :taskId];
        Assert.areEqual(rep.OwnerId, t.OwnerId, 'Task goes to the deal owner');
        Assert.areEqual(rep.Id, t.WhatId);
        Assert.areEqual('High', t.Priority);
        Assert.areEqual(Date.valueOf(due), t.ActivityDate);
    }

    @IsTest
    static void createFollowUpTaskRequiresSubject() {
        try {
            PipelineCommandCenterController.createFollowUpTask(opp('Rep Overdue').Id, ' ', null, null, null);
            Assert.fail('Expected an exception');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('subject'), e.getMessage());
        }
    }

    @IsTest
    static void coachingNoteValidation() {
        Id oppId = opp('Rep Overdue').Id;
        try {
            PipelineCommandCenterController.postCoachingNote(oppId, '');
            Assert.fail('Expected an exception');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('Write a note'), e.getMessage());
        }
        try {
            PipelineCommandCenterController.postCoachingNote(oppId, 'x'.repeat(5001));
            Assert.fail('Expected an exception');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('limited'), e.getMessage());
        }
    }

    @IsTest
    static void dealInsightsReturnsPostsAndTasks() {
        Opportunity rep = opp('Rep Overdue');
        insert new FeedItem(ParentId = rep.Id, Body = 'Pricing approved');
        insert new List<Task>{
            new Task(WhatId = rep.Id, Subject = 'Overdue call', ActivityDate = Date.today().addDays(-2), Status = 'Not Started'),
            new Task(WhatId = rep.Id, Subject = 'Done call', ActivityDate = Date.today().addDays(-9), Status = 'Completed')
        };

        PipelineCommandCenterController.DealInsights insights = PipelineCommandCenterController.getDealInsights(rep.Id);

        Assert.areEqual(1, insights.posts.size());
        Assert.areEqual('Pricing approved', insights.posts[0].body);
        Assert.areEqual(2, insights.tasks.size());
        Assert.areEqual('Overdue call', insights.tasks[0].subject, 'Open tasks are listed first');
        Assert.isTrue(insights.tasks[0].isOverdue);
    }
}
