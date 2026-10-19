# Admin Desk

Signing into admin clears the store session from both browser storage locations. Admin requests cannot authenticate as a store or perform `store_*` combat actions. Exiting admin leaves the store unselected.

## Test Zone

Open **Admin Desk → Test Zone → Enter isolated Test Zone**. All admin tabs then operate on sandbox data. The phase badge and desk banner mark test mode; PNG exports are marked TEST ZONE.

The sandbox uses a separate strong-consistency Netlify Blobs store (`knockout-blitz-sandbox`) and never migrates live legacy data. Locally it uses a `.sandbox` database alongside the live file. Every sandbox request requires admin authentication. The production scheduled function operates only on live storage.

Load sample stores at opening, an open round, deflection unlock, or Power Hours. The clock stays frozen until advanced with the controls. Test attacks, revivals, shields, sales cutoffs, and event lifecycle use the normal server engine. Deflection samples explicitly seed the two prerequisite survivals. Google Sheet imports are disabled in the sandbox. The sandbox is shared by authenticated admins, not private to a browser.

## Tournament controls

- **Save numbers:** download a full JSON snapshot and save a server backup.
- **RESET COMBAT:** restore all stores, clear combat spending/damage/defense and per-round attack allowances, and restore available points from earned points. Preserve sales, pending sales, weekly records, current event timing, and already recorded event results. This does not reopen a closed event.
- **NEW TOURNAMENT:** archive the current week, replace active game state with a fresh roster and zero scores, and assign a new tournament ID.
- **CLEAR DATABASE:** replace active game data and weekly archives with a fresh roster and zero scores. The official roster, enabled-day settings, and access codes remain. This does not erase saved backups.

Each reset requires its exact confirmation phrase and a successful server backup before any active data is replaced. Backups use separate live/sandbox Blobs stores; disk development writes them to `<database-path>.backups/`. If persistence or backup creation fails, reset must fail.

New tournament and clear database **pause sheet imports** so existing sheet totals cannot immediately refill scores. Explicitly resume imports in Tournament controls when ready; existing source totals may be credited again. Regular event scheduling remains enabled according to the configured event days. These operations do not alter the Google Sheet.

## Responsive behavior

Admin opens Event/Rounds by default, with store cards available through Daily Arena. Controls have 44px touch targets, form inputs avoid iOS zoom, layouts collapse for smaller screens, and wide tables scroll within their containers. The mobile admin header and telemetry are compact. Hidden views are not rendered, polling pauses in background tabs, overlapping polls are skipped, and switching zones rejects late responses from the previous zone.
