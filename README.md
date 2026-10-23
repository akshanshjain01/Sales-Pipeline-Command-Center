# Sales Pipeline Command Center

One Lightning Web Component that gives a sales manager everything they need for the daily pipeline review on one screen: pipeline health, at-risk and high-value deals, inline updates, list and Kanban views, fast filtering, and live updates from the team.

## The problem it solves

Today a manager jumps between list views (to find deals), reports (to see totals) and Opportunity pages (to update or chase a rep). The command center puts all of that on one screen:

| Daily question | Where it is answered |
| --- | --- |
| "How healthy is my team's pipeline?" | KPI tiles: open pipeline, weighted forecast, closing this month, at risk, past close date, high value, won this quarter + win rate |
| "Which deals need me today?" | A **health score (0-100)** on every deal, with the reasons shown (e.g. "Close date passed 12d ago · No activity in 30d") |
| "Show me only the problems" | Click a KPI tile or a stage bar to filter. Chips for "Closing in 30 days" and "No next step". Search across deal, account, owner and next step |
| "Fix it now" | Edit stage, amount, probability, close date and next step inline in the list. Drag cards between stages on the board, or use the one-click "advance to next stage" arrow |
| "Get the rep moving" | Side panel per deal: full edit form, **coaching note** posted to Chatter that @mentions the owner, and **assign a follow-up task** to the owner |
| "What did my team just change?" | Live team activity feed. Deals changed by teammates are highlighted in the list and on the board |
| "Send this to my VP" | Export the filtered list to CSV |

## What's in the box

```
force-app/main/default/
├── classes/
│   ├── PipelineCommandCenterController.cls   # load, delta sync, coaching note, follow-up task
│   ├── PipelineHealthService.cls             # health score + risk reasons (pure, unit-tested)
│   └── *Test.cls                             # 18 Apex tests
├── lwc/
│   ├── pipelineCommandCenter/                # main component (state, filters, live updates)
│   ├── pipelineSummary/                      # KPI tiles + stage funnel
│   ├── pipelineDatatable/                    # lightning-datatable + custom types (deal, health, picklist edit)
│   ├── pipelineKanban/                       # drag-and-drop board, paged columns
│   ├── pipelineDealPanel/                    # side panel: edit, coach, follow-up task
│   ├── pipelineHealthBadge/ pipelineDealCell/
│   └── pipelineUtils/                        # pure JS: filters, KPIs, dates, CSV (Jest-tested)
├── applications/Sales_Command_Center         # Lightning app
├── tabs/Pipeline_Command_Center              # LWC tab
├── permissionsets/Pipeline_Command_Center    # app + tab + Apex access
├── platformEventChannels/                    # custom CDC channel PipelineCommandCenter__chn (packageable)
└── platformEventChannelMembers/              # adds Opportunity changes to that channel
scripts/apex/
├── 1_createSalesReps.apex                    # 2 reps reporting to you + permission set
├── 2_createPipelineData.apex                 # 30 accounts, 320 opportunities, ~385 tasks, Chatter posts
├── 3_pushCloseDates.apex                     # run twice: creates "slipping" deals (PushCount = 2)
└── 9_deleteDemoData.apex                     # removes the demo data
```

## Setup

```bash
sf project deploy start -d force-app -o <org>
sf apex run -f scripts/apex/1_createSalesReps.apex -o <org>
sf apex run -f scripts/apex/2_createPipelineData.apex -o <org>
sf apex run -f scripts/apex/3_pushCloseDates.apex -o <org>
sf apex run -f scripts/apex/3_pushCloseDates.apex -o <org>
```

Open the **Sales Command Center** app (App Launcher) → **Pipeline Command Center** tab.
The component can also be dropped on any App or Home page from Lightning App Builder, where the title, high-value threshold, "stale after" days, default view and default scope can be set.

Tests:

```bash
sf apex run test -n PipelineCommandCenterControllerTest -n PipelineHealthServiceTest -n PipelineCoachingNoteTest -r human -w 10
npm install && npm run test:unit
```

## Install as a package (other orgs)

The project is published as an **unlocked package**, owned by the SalesPipelinePOC org (Dev Hub).

| | |
| --- | --- |
| Package | Pipeline Command Center (`0Hog800000057FNCAY`) |
| Released version | 1.0.0-1 (`04tg8000000VzdVAAS`), 93% Apex coverage |
| Production / Developer install link | https://login.salesforce.com/packaging/installPackage.apexp?p0=04tg8000000VzdVAAS |
| Sandbox install link | https://test.salesforce.com/packaging/installPackage.apexp?p0=04tg8000000VzdVAAS |

Install from the CLI:

```bash
sf package install -p 04tg8000000VzdVAAS -o <target-org> -w 20 -s AdminsOnly
sf org assign permset -n Pipeline_Command_Center -o <target-org>   # for each user who needs it
```

After installing:
1. Assign the **Pipeline Command Center** permission set to managers and reps.
2. Open App Launcher → **Sales Command Center**.
3. Optional: set **Manager** on rep user records so *My team* shows their deals.

The package contains only the app, tab, components, Apex, permission set and the `PipelineCommandCenter__chn` change-event channel. It needs no custom fields. Demo data is not included; run `scripts/apex/2_createPipelineData.apex` in a test org if you want it.
Change Data Capture allows a limited number of selected objects per org (5 in Developer Edition); the package uses one (Opportunity).

Release a new version after changes:

```bash
# bump versionNumber in sfdx-project.json (e.g. 1.1.0.NEXT), then
sf package version create -p "Pipeline Command Center" --installation-key-bypass --code-coverage -w 60
sf package version promote -p "Pipeline Command Center@1.1.0-1"
sf package install -p "Pipeline Command Center@1.1.0-1" -o <target-org> -w 20   # upgrades in place
```

## How the health score works

Every open deal starts at 100. Each risk takes points off and adds a readable reason:

| Signal | Rule (standard fields only) | Points |
| --- | --- | --- |
| Past close date | `CloseDate` before today | −30 |
| Closing soon, early stage | closes within 30 days at under 50% probability | −20 |
| Stale | last activity older than *stale days* (default 14) | −20 |
| No activity | no activity logged at all | −15 |
| Stuck | in current stage over 3× stale days (`LastStageChangeDate`) | −15 |
| Slipping | close date pushed 2+ times (`PushCount`) | −15 |
| Overdue task | `HasOverdueTask` | −10 |
| No next step | `NextStep` blank | −10 |
| No amount | `Amount` blank or 0 | −5 |

Below 60 = **At risk**, below 80 = **Watch**, otherwise **Healthy**. The rules live in one Apex class (`PipelineHealthService`), so they are easy to tune or move to Custom Metadata later.

## Design decisions

- **Load once, filter in the browser.** One Apex call loads the working set (all open deals plus deals closed this fiscal quarter, up to 2,000). Search, filters, sorting and KPIs then run in memory with no server round trip, so the screen stays instant with hundreds of deals. If the cap is hit, a banner says so and suggests a narrower scope.
- **Render only what is visible.** The list renders 50 rows and loads more as you scroll; each Kanban column renders 25 cards with "Show more". The KPIs always reflect the whole set.
- **Saves go through Lightning Data Service (`updateRecord`)**, so validation rules, FLS and the record cache behave exactly like the standard UI. Board moves are optimistic (the card moves at once) and roll back with the error message if Salesforce rejects the change. Moving a deal to Closed Won/Lost asks for confirmation first.
- **Near real-time collaboration.** The component subscribes to Opportunity **Change Data Capture**. An event only says *which* records changed; the component then re-reads just those deals through Apex with sharing, so users never see data they shouldn't. If streaming is unavailable for a user, it falls back to checking for changes every 45 seconds. Either way only the changed deals are merged in (no full reload), and the team activity feed shows who changed what.
- **Security.** All Apex is `with sharing` and uses `WITH USER_MODE` / `AccessLevel.USER_MODE` for queries and DML, so sharing, object and field permissions are enforced.
- **Scopes.** *My team* = you plus everyone up to three levels below you on the User Manager field. *My deals* and *All I can see* (everything sharing allows) are one click away. Your view, scope and funnel choice are remembered per browser.
- **No custom fields or objects.** It runs on standard Opportunity fields, so it can be dropped into an existing org.

## Demo walkthrough (5 minutes)

1. Open the tab: the KPI tiles show the team's pipeline. Click **At risk**: the list narrows to the deals that need attention, worst reasons visible in the Health column.
2. Click a deal name: the side panel explains the score. Change the close date and save, or use **Coach rep → Post and notify**.
3. Click **Past close date**, then inline-edit several close dates in the list and save them in one go.
4. Switch to **Kanban**, drag a deal to the next stage (or use the → arrow). Drag one to **Closed Won** and confirm.
5. In another browser tab, edit any opportunity on its record page (or log in as Maya Patel from Setup → Users). Within a second the change appears in **Team activity** and the deal is highlighted in the list and board, without a refresh.

## Known limits and next steps

- Quarter/month filters in the browser use calendar periods; the "won this quarter" data uses the org's fiscal quarter.
- The working set is capped at 2,000 deals per load; larger teams should use *My team* or *My deals* (or a server-side paging mode, next iteration).
- Multi-currency orgs: amounts are shown in the user's currency without conversion.
- Ideas for later: Custom Metadata for risk weights, forecast category roll-up, saved views, and an Agentforce action to draft the coaching note.
