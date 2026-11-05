# The Bay Bar design: reliable development launch

## Permanent workflow
The Bay Bar UI is developed on `design/the-bay-exact-html-integration` (local `test-bay-design`). Normal and demo use the same POS components in `frontend/src/app/(dashboard)/pos/page.tsx`, `ProductGrid.tsx`, and `PosTopbar.tsx`. Demo should change data and display a training banner, **not** substitute an old register UI.

1. Close **all** FloPOS/Electron windows.
2. Run `cd ~/smalltownos-pos && git pull --ff-only`.
3. Run `bash scripts/dev/launch-bay-design.sh`.
4. Check that the topbar has **no blue B logo**, says **SmallTownPOS**, and the catalog offers **Quick-Tap Grid**. If not, inspect Electron's loaded URL and JavaScript bundle; do not rebuild repeatedly.

The launcher checks the branch, source design marker, running Electron instances, compiled server register, and browser JavaScript before launching. It prints the Git commit. It **does not** run `dev:reset`, remove `flo.db`, or delete profiles/backups. Existing npm scripts may perform their usual builds; inspect them before changing.

## Troubleshooting
- Wrong branch: switch to `test-bay-design` only after checking local changes.
- Already-running Electron: close the windows; don't kill arbitrary processes.
- Missing browser/server marker: build failed or wrong source; inspect build output.
- Correct markers but wrong UI: use Electron Developer Tools to inspect the loaded URL, network requests, and `/pos/page-*.js` chunk. Do not assume the build is wrong.
- `git pull` conflict: preserve local changes, especially modified `package.json`, `package-lock.json`, `frontend/public/menu-generic/`, and `flo.db.backup-*`. Never run `git clean` or `git reset --hard`.

## Pending
A `npm run dev:bay` alias should be added only after reconciling the workstation's **locally modified** package.json and package-lock.json, to avoid blocking pulls. Until then the standalone script is the safe one-command launcher.

## November 5: verified restart and demo observations

The user confirmed the launcher opened FloPOS after the previous Electron instance was stopped. This was the key operational issue behind repeated failed restarts. The recommended sequence after every UI edit is:

1. Close all FloPOS windows, including Demo Mode.
2. In Ubuntu, run:
   ```bash
   cd ~/smalltownos-pos
   git pull --ff-only
   bash scripts/dev/launch-bay-design.sh
   ```
3. Wait for the build and Electron startup. Do not launch a second instance.
4. Check that the blue B logo is absent, the subtitle is SmallTownPOS, and the new category tiles and Quick-Tap Grid appear.

If the launcher reports Electron is already running, close the application normally. If it remains running, inspect current FloPOS process IDs using `pgrep -af '/node_modules/electron/dist/electron'`. In the incident, the old main Electron process was terminated, the process list became empty, and the launcher opened successfully. Process IDs change; never reuse historical IDs.

Demo was observed using Electron's profile directory `/home/s/.config/flo-desktop-demo` and the app path `/home/s/smalltownos-pos`. The same Electron process was listening on ports 3001, 3002 and 3003. Port 3001 redirected `/pos` to `/pos/` normally. The server and browser bundles contained Quick-Tap Grid, but static HTML searches did not prove which UI the renderer loaded. To investigate a future discrepancy, compare the actual loaded `/pos/page-*.js` browser resource in Electron Developer Tools with the current compiled bundle. Do not assume a rebuild alone fixes the problem.

The intended demo contract is the same register UI as normal mode, with training data and a demo indicator. This contract still needs end-to-end visual and functional verification; do not claim it has been proven merely because Electron launched.

## Register design and search decisions

- Keep the real POS backend, product data, orders, tables, dual USD/KHR behavior, and existing database.
- No invented B logo. Compact Bay Bar topbar with SmallTownPOS subtitle and Geist typography.
- Compact table cards with Pax and status labels.
- Six fixed-size colored category tiles: Beer, Wine, Cocktails, Spirits, Food and Drinks.
- Quick-Tap Grid with yellow lightning icon; Photo View remains available.
- On desktop, show four columns of larger product buttons, with names readable across two lines. The left card border uses the selected category color.
- Tap the active category again to deselect it and show all products.
- With a category selected, search only that category. With no category selected, search all products. Clear the search without losing the category selection.
- Type directly from the register to begin searching without first clicking the input. Protect active form fields, dialogs and shortcuts.
- Offline smart search supports partial words (burger/hamburger), aliases (chips/fries and coke/cola), typo tolerance, and relevance ordering. Barcode Enter handling should remain intact.
- These changes are code commits, not proof that all interactions have been tested on the user's workstation.

Notable commits: `d5cd45e` (four columns), `aba441f` (category deselection), `49556e3` and `e9d3847` (type-to-search), `ac4f4b4` (category-scoped search), `b69c90c` (smart search).

## Data and local-change safeguards

Do not reset the application or replace local SQLite data to solve visual problems. Preserve `flo.db`, its backups, and Electron user profiles. The workstation previously showed local modifications to `package.json` and `package-lock.json`, and untracked menu assets and backup files. Review these before altering package scripts or cleaning the worktree. The standalone launcher avoids modifying those package files.

## Next improvements

Add an About/Settings build identifier so the running commit is visible. Consider a shorter launch alias after reconciling local package modifications. Test the Demo Mode path, register appearance, smart search, barcode behavior, and payment input focus before declaring the UI finished.
