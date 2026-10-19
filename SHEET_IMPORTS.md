# Automatic sheet imports

The scheduled job reads Google Sheets every minute and writes snapshots into the durable app database. Imports match store IDs and do not require an open browser or a manual approval step for after-close sheet sales.

During an open event, sales still pass through the three-minute cutoffs. After closing (including a draw), the final sheet quantities settle the report's earnings and weekly ledger without replaying combat, restoring eliminated stores, or awarding retroactive qualifiers. Unmatched manual entries and admin point adjustments remain separate. Identical imports are idempotent.

## Reporting date

An optional `Report Date,YYYY-MM-DD` field in the sheet takes precedence. Without a report date, the app records the Eastern date on which it first observes the report. Across midnight, unchanged undated data remains on that report date. A counter decrease/reset, or a previously empty report on a later day, starts a new daily report. If a sheet changes days without any observable reset, add the report date to make attribution unambiguous; aggregate totals alone cannot prove transaction dates.

Weekly ownership comes from the report day's scheduled event start, not its import timestamp. Sunday closing sales imported after 7 PM therefore belong to the week that just ended. They do not become Monday's opening balance in the new week.

`sheetReports` stores each dated report; `latestSheetReport` exposes the latest source quantities and sheet-earned points on store cards. Closed reports update their corresponding `weeklyArchives` record when their week has ended. Current-week zero balances can be correct immediately after a weekly reset even while the latest sheet report shows the preceding week's sales.

## Recovery and corrections

The first new import recovers legacy `LATE_CROSS_BOUNDARY_SALE` issues from Google Sheets, records their automatic attribution, and prevents repeat credit. Manual late entries remain subject to the existing attribution workflow. Imported reports and corrections are audited. The job records source errors instead of reporting a failed import as successful.
