# Update the shared Google Sheet report

Google deployment reference: https://developers.google.com/apps-script/concepts/deployments

1. Open your Google Sheet, then Extensions > Apps Script.
2. Replace Code.gs with the complete contents of [Code.gs](Code.gs) in this folder.
3. Keep the existing TITLEPULSE_SECRET in Project Settings > Script Properties.
4. Save. Choose Deploy > Manage deployments > Edit (pencil).
5. Select Version > New version, then Deploy. Keep Execute as Me and your existing access setting.
6. This updates the existing /exec URL, so no backend URL change is needed.
7. Deploy the updated TitlePulse backend and reload the extension.
8. Run an analysis, click Save to Google Sheet, enter the team password, then Submit.

The first new save reformats that website's tab. Other website tabs remain unchanged until saved again. No live spreadsheet edits were made by this code update.

One tab per hostname is preserved via TITLEPULSE_WEBSITE metadata (compatible with the earlier script). Existing manually created tabs are never overwritten. All matching evidence is retained in the report, alongside full source articles. Website Report in Excel uses the same layout; Ranked Analysis and Source Titles retain the raw tables for filtering.

The popup password is SHEETS_TEAM_KEY, not the private Apps Script secret. It is cleared after successful saving or Cancel. Partial/empty analyses replace the previous site's data and are explicitly labeled. The report has a 20,000-row limit and the transport retains its 2 MB limit; oversized results fail without silently exporting only the top ten.

For an already saved cached job, the backend returns the prior confirmation rather than writing again. Redeployment clears the cache; otherwise wait 15 minutes and analyze again to refresh an existing report.

Live checks after deployment: save one website twice (same tab), save a second website (new tab), inspect a partial analysis, click a source URL, and verify titles beginning with = remain text.
