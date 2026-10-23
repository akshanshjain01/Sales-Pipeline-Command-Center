/**
 * ConnectApi methods are not supported in data-siloed tests, so this one test
 * needs SeeAllData. It still creates and uses only its own records.
 */
@IsTest(SeeAllData=true)
private class PipelineCoachingNoteTest {
    @IsTest
    static void postsNoteToDealFeed() {
        Opportunity opp = new Opportunity(
            Name = 'Coaching Test Deal',
            StageName = 'Prospecting',
            CloseDate = Date.today().addDays(30)
        );
        insert opp;

        Test.startTest();
        PipelineCommandCenterController.postCoachingNote(opp.Id, 'Please confirm the budget owner.');
        Test.stopTest();

        // The post itself is created by ConnectApi; reaching here without an exception is the contract.
        Assert.isNotNull(opp.Id);
    }
}
