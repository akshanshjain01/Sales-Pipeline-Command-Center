// Step 1 of the demo data: two sales reps who report to the running user (the sales manager).
// Safe to run again: existing reps are reused.
Profile standard = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
User me = [SELECT Id, TimeZoneSidKey, LocaleSidKey, LanguageLocaleKey, EmailEncodingKey FROM User WHERE Id = :UserInfo.getUserId()];
String domain = UserInfo.getOrganizationId().left(15).toLowerCase() + '.pcc.demo';

List<List<String>> reps = new List<List<String>>{
    new List<String>{ 'Maya', 'Patel', 'mpatel' },
    new List<String>{ 'Diego', 'Alvarez', 'dalvarez' }
};

Set<String> usernames = new Set<String>();
for (List<String> r : reps) {
    usernames.add(r[2] + '@' + domain);
}
Map<String, User> existing = new Map<String, User>();
for (User u : [SELECT Id, Username FROM User WHERE Username IN :usernames]) {
    existing.put(u.Username, u);
}

Database.DMLOptions opts = new Database.DMLOptions();
opts.EmailHeader.triggerUserEmail = false;

List<User> toUpsert = new List<User>();
for (List<String> r : reps) {
    String username = r[2] + '@' + domain;
    User u = existing.containsKey(username) ? existing.get(username) : new User(Username = username);
    u.FirstName = r[0];
    u.LastName = r[1];
    u.Alias = r[2].left(8);
    u.Email = r[2] + '@example.com';
    u.ProfileId = standard.Id;
    u.ManagerId = me.Id;
    u.IsActive = true;
    u.Title = 'Account Executive';
    u.TimeZoneSidKey = me.TimeZoneSidKey;
    u.LocaleSidKey = me.LocaleSidKey;
    u.LanguageLocaleKey = me.LanguageLocaleKey;
    u.EmailEncodingKey = me.EmailEncodingKey;
    u.setOptions(opts);
    toUpsert.add(u);
}
List<User> toInsert = new List<User>();
List<User> toUpdate = new List<User>();
for (User u : toUpsert) {
    if (u.Id == null) {
        toInsert.add(u);
    } else {
        toUpdate.add(u);
    }
}
insert toInsert;
update toUpdate;

// Give the manager and the reps access to the command center.
PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Pipeline_Command_Center'];
Set<Id> assignees = new Set<Id>{ me.Id };
for (User u : toUpsert) {
    assignees.add(u.Id);
}
for (PermissionSetAssignment psa : [SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :ps.Id]) {
    assignees.remove(psa.AssigneeId);
}
List<PermissionSetAssignment> psas = new List<PermissionSetAssignment>();
for (Id userId : assignees) {
    psas.add(new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = ps.Id));
}
insert psas;
System.debug('Reps ready: ' + toUpsert.size() + ', new permission set assignments: ' + psas.size());
