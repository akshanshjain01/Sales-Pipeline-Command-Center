// Step 3 of the demo data: push the close date of tagged deals into a later month.
// Salesforce counts each push in Opportunity.PushCount, which the command center
// flags as "slipping" from 2 pushes. Run this script twice.
List<Opportunity> slipping = new List<Opportunity>();
for (Opportunity o : [
    SELECT Id, CloseDate, Description
    FROM Opportunity
    WHERE IsClosed = FALSE
]) {
    if (o.Description != null && o.Description.endsWith('| slip')) {
        o.CloseDate = o.CloseDate.addMonths(1).addDays(5);
        slipping.add(o);
    }
}
update slipping;
System.debug('Pushed ' + slipping.size() + ' deals');
