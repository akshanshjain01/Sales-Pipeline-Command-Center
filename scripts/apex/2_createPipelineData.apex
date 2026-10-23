// Step 2 of the demo data: accounts, ~320 opportunities, tasks and Chatter posts.
// Run 1_createSalesReps.apex first. Run 9_deleteDemoData.apex to start over.
//
// The mix is tuned so the command center has something to show:
// ~280 open deals across every stage, ~40 won/lost this quarter, overdue and
// soon-to-close deals, stale deals, missing next steps, overdue tasks and big deals.

final String MARKER = 'PCC demo data';
Date today = Date.today();

// Simple seeded random so every run produces the same-looking pipeline.
Long[] seed = new Long[]{ 20261022L };
Integer nextInt(Long[] s, Integer bound) {
    s[0] = Math.mod(s[0] * 1103515245L + 12345L, 2147483647L);
    return (Integer) Math.mod(s[0], (Long) bound);
}

// ---------- owners: the manager (running user), the two reps, plus one user outside the team
Id managerId = UserInfo.getUserId();
List<Id> teamOwners = new List<Id>{ managerId };
for (User u : [SELECT Id FROM User WHERE ManagerId = :managerId AND IsActive = TRUE ORDER BY CreatedDate LIMIT 5]) {
    teamOwners.add(u.Id);
}
List<User> others = [
    SELECT Id
    FROM User
    WHERE IsActive = TRUE AND UserType = 'Standard' AND Profile.Name = 'System Administrator' AND Id != :managerId AND Id NOT IN :teamOwners
    LIMIT 1
];
Id outsiderId = others.isEmpty() ? null : others[0].Id;

// ---------- accounts
List<String> accountNames = new List<String>{
    'Northwind Logistics', 'Bluepeak Energy', 'Crestline Health', 'Harborview Bank', 'Summit Retail Group',
    'Ironwood Manufacturing', 'Lumen Analytics', 'Pinecrest Foods', 'Silverline Telecom', 'Evergreen Insurance',
    'Redstone Construction', 'Clearwater Utilities', 'Brightpath Education', 'Atlas Freight', 'Granite Capital',
    'Horizon Pharma', 'Maple Leaf Hospitality', 'Orion Aerospace', 'Riverbend Media', 'Sterling Legal',
    'Tidewater Marine', 'Vantage Software', 'Willow Creek Wellness', 'Zenith Automotive', 'Cobalt Mining',
    'Keystone Properties', 'Nova Biotech', 'Peregrine Security', 'Quartz Semiconductors', 'Sapphire Travel'
};
List<String> industries = new List<String>{
    'Transportation', 'Energy', 'Healthcare', 'Banking', 'Retail', 'Manufacturing', 'Technology', 'Food & Beverage',
    'Communications', 'Insurance', 'Construction', 'Utilities', 'Education', 'Transportation', 'Finance',
    'Biotechnology', 'Hospitality', 'Engineering', 'Media', 'Consulting', 'Shipping', 'Technology', 'Healthcare',
    'Manufacturing', 'Energy', 'Not For Profit', 'Biotechnology', 'Technology', 'Electronics', 'Recreation'
};
List<Account> accounts = new List<Account>();
for (Integer i = 0; i < accountNames.size(); i++) {
    accounts.add(
        new Account(
            Name = accountNames[i],
            Industry = industries[i],
            Type = Math.mod(i, 3) == 0 ? 'Prospect' : 'Customer - Direct',
            AnnualRevenue = (nextInt(seed, 90) + 10) * 10000000,
            NumberOfEmployees = (nextInt(seed, 95) + 5) * 100,
            Description = MARKER
        )
    );
}
insert accounts;

// ---------- opportunities
List<String> products = new List<String>{
    'Platform License', 'Data Cloud Expansion', 'Service Renewal', 'Analytics Add-on', 'Implementation Services',
    'Enterprise Upgrade', 'Pilot Program', 'Multi-year Renewal', 'Security Suite', 'Field Service Rollout'
};
List<String> nextSteps = new List<String>{
    'Demo for IT team on Thursday', 'Send revised pricing', 'Security review with CISO', 'Legal redlines due Friday',
    'Exec sponsor meeting', 'Confirm budget with CFO', 'Technical deep dive', 'Procurement onboarding',
    'Reference call with existing customer', 'Proposal walkthrough', 'Schedule discovery call', 'Draft SOW'
};
List<String> types = new List<String>{ 'New Customer', 'Existing Customer - Upgrade', 'Existing Customer - Replacement' };
List<String> sources = new List<String>{ 'Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other' };

// Open stages and how many deals in each (a realistic funnel).
Map<String, Integer> openMix = new Map<String, Integer>{
    'Prospecting' => 50,
    'Qualification' => 45,
    'Needs Analysis' => 40,
    'Value Proposition' => 35,
    'Id. Decision Makers' => 30,
    'Perception Analysis' => 25,
    'Proposal/Price Quote' => 30,
    'Negotiation/Review' => 25
};

Date quarterStart = Date.newInstance(today.year(), ((today.month() - 1) / 3) * 3 + 1, 1);
List<Period> quarters = [SELECT StartDate FROM Period WHERE Type = 'Quarter' AND StartDate <= TODAY AND EndDate >= TODAY LIMIT 1];
if (!quarters.isEmpty()) {
    quarterStart = quarters[0].StartDate;
}
Integer daysIntoQuarter = Math.max(1, quarterStart.daysBetween(today));
Date monthEnd = today.toStartOfMonth().addMonths(1).addDays(-1);

Decimal amountFor(Long[] s) {
    Integer roll = nextInt(s, 100);
    if (roll < 3) {
        return null; // a few deals with no amount yet
    }
    if (roll < 60) {
        return (nextInt(s, 46) + 5) * 1000; // 5k - 50k
    }
    if (roll < 88) {
        return (nextInt(s, 101) + 50) * 1000; // 50k - 150k
    }
    return (nextInt(s, 36) + 15) * 10000; // 150k - 500k
}

Id ownerFor(Long[] s, List<Id> team, Id outsider) {
    Integer roll = nextInt(s, 100);
    if (outsider != null && roll < 7) {
        return outsider;
    }
    return team[Math.mod(roll, team.size())];
}

List<Opportunity> opps = new List<Opportunity>();
Integer n = 0;
for (String stage : openMix.keySet()) {
    for (Integer i = 0; i < openMix.get(stage); i++) {
        Account acc = accounts[nextInt(seed, accounts.size())];
        Integer roll = nextInt(seed, 100);
        Date closeDate;
        if (roll < 12) {
            closeDate = today.addDays(-(nextInt(seed, 40) + 1)); // past close date
        } else if (roll < 35) {
            closeDate = today.addDays(nextInt(seed, Math.max(1, today.daysBetween(monthEnd) + 1))); // this month
        } else {
            closeDate = today.addDays(nextInt(seed, 170) + 10); // next 6 months
        }
        opps.add(
            new Opportunity(
                Name = acc.Name + ' - ' + products[nextInt(seed, products.size())],
                AccountId = acc.Id,
                OwnerId = ownerFor(seed, teamOwners, outsiderId),
                StageName = stage,
                CloseDate = closeDate,
                Amount = amountFor(seed),
                Type = types[nextInt(seed, types.size())],
                LeadSource = sources[nextInt(seed, sources.size())],
                NextStep = nextInt(seed, 100) < 78 ? nextSteps[nextInt(seed, nextSteps.size())] : null,
                // Some deals are tagged so script 3 can push their close date (shows "slipping" risk).
                Description = MARKER + (nextInt(seed, 100) < 10 && closeDate >= today ? ' | slip' : '')
            )
        );
        n++;
    }
}

// Closed this quarter: 25 won, 15 lost.
for (Integer i = 0; i < 40; i++) {
    Account acc = accounts[nextInt(seed, accounts.size())];
    Boolean won = i < 25;
    opps.add(
        new Opportunity(
            Name = acc.Name + ' - ' + products[nextInt(seed, products.size())],
            AccountId = acc.Id,
            OwnerId = ownerFor(seed, teamOwners, outsiderId),
            StageName = won ? 'Closed Won' : 'Closed Lost',
            CloseDate = quarterStart.addDays(nextInt(seed, daysIntoQuarter)),
            Amount = (nextInt(seed, 120) + 8) * 1000,
            Type = types[nextInt(seed, types.size())],
            LeadSource = sources[nextInt(seed, sources.size())],
            Description = MARKER
        )
    );
}
insert opps;

// ---------- tasks: these drive "last activity", "stale" and "overdue task" signals
List<String> taskSubjects = new List<String>{
    'Discovery call', 'Follow-up email', 'Pricing discussion', 'Demo', 'Check-in call', 'Send case study',
    'Stakeholder meeting', 'Contract review'
};
List<Task> tasks = new List<Task>();
for (Opportunity o : opps) {
    Boolean isOpen = !o.StageName.startsWith('Closed');
    Integer roll = nextInt(seed, 100);
    if (!isOpen || roll < 55) {
        // recent completed activity
        tasks.add(
            new Task(
                WhatId = o.Id,
                OwnerId = o.OwnerId,
                Subject = taskSubjects[nextInt(seed, taskSubjects.size())],
                ActivityDate = today.addDays(-(nextInt(seed, 10) + 1)),
                Status = 'Completed',
                Priority = 'Normal'
            )
        );
    } else if (roll < 80) {
        // old activity only -> stale
        tasks.add(
            new Task(
                WhatId = o.Id,
                OwnerId = o.OwnerId,
                Subject = taskSubjects[nextInt(seed, taskSubjects.size())],
                ActivityDate = today.addDays(-(nextInt(seed, 45) + 18)),
                Status = 'Completed',
                Priority = 'Normal'
            )
        );
    }
    // else: no activity at all

    if (isOpen) {
        Integer openRoll = nextInt(seed, 100);
        if (openRoll < 15) {
            tasks.add(
                new Task(
                    WhatId = o.Id,
                    OwnerId = o.OwnerId,
                    Subject = 'Send follow-up: ' + taskSubjects[nextInt(seed, taskSubjects.size())],
                    ActivityDate = today.addDays(-(nextInt(seed, 12) + 1)),
                    Status = 'Not Started',
                    Priority = 'High'
                )
            );
        } else if (openRoll < 40) {
            tasks.add(
                new Task(
                    WhatId = o.Id,
                    OwnerId = o.OwnerId,
                    Subject = taskSubjects[nextInt(seed, taskSubjects.size())],
                    ActivityDate = today.addDays(nextInt(seed, 14) + 1),
                    Status = 'Not Started',
                    Priority = 'Normal'
                )
            );
        }
    }
}
insert tasks;

// ---------- a few Chatter posts so the collaboration panel has history
List<String> posts = new List<String>{
    'Customer asked for a 3-year price lock. Looping in deal desk.',
    'Champion is leaving the company end of month - need a new sponsor.',
    'Security questionnaire submitted, waiting on their review.',
    'Great demo today, they want a proposal by next week.',
    'Procurement pushed back on payment terms. Proposing net 45.',
    'Competitor is in the deal, we need a stronger ROI story.'
};
List<FeedItem> feed = new List<FeedItem>();
for (Integer i = 0; i < 18; i++) {
    Opportunity o = opps[nextInt(seed, n)];
    feed.add(new FeedItem(ParentId = o.Id, Body = posts[nextInt(seed, posts.size())], Type = 'TextPost'));
}
insert feed;

System.debug(
    'Created ' + accounts.size() + ' accounts, ' + opps.size() + ' opportunities, ' + tasks.size() +
    ' tasks, ' + feed.size() + ' posts. Team owners: ' + teamOwners.size() + ', outsider: ' + outsiderId
);
