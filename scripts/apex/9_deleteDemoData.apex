// Removes everything created by 2_createPipelineData.apex (opportunities, tasks, posts, accounts).
// The two demo reps are left in place; users can only be deactivated, not deleted.
// Description is a long text field (not filterable in SOQL), so the marker is checked in Apex.
List<Account> accounts = new List<Account>();
for (Account a : [SELECT Id, Description FROM Account LIMIT 5000]) {
    if (a.Description == 'PCC demo data') {
        accounts.add(a);
    }
}
List<Opportunity> opps = [SELECT Id FROM Opportunity WHERE AccountId IN :accounts];
delete [SELECT Id FROM Task WHERE WhatId IN :opps];
delete opps;
delete accounts;
System.debug('Deleted ' + opps.size() + ' opportunities and ' + accounts.size() + ' accounts');
