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
