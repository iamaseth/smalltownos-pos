# BackStreet: copy the newest nightly POS backup from Railway to this PC (and to Google Drive).
# Runs every morning from Windows Task Scheduler. Needs the same key as FLO_BACKUP_PULL_KEY in
# Railway, saved in C:\BackStreet-Backups\key.txt (never put the key in this file).
#
# - Saves to C:\BackStreet-Backups (the offline copy, kept 30 days).
# - Also copies into the Google Drive folder below when Google Drive for desktop is running.
# - Writes what happened to C:\BackStreet-Backups\log.txt.

$PosAddress  = 'https://YOUR-POS-ADDRESS.up.railway.app'   # the POS address from Railway
$LocalFolder = 'C:\BackStreet-Backups'
$DriveFolder = 'G:\My Drive\backstreet POS data backup'
$KeepDays    = 30

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LocalFolder | Out-Null
$log = Join-Path $LocalFolder 'log.txt'
function Write-Log($text) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm}  {1}" -f (Get-Date), $text) }

try {
  $key = (Get-Content -Path (Join-Path $LocalFolder 'key.txt') -Raw).Trim()
  $tmp = Join-Path $LocalFolder 'downloading.tmp'
  $res = Invoke-WebRequest -Uri "$PosAddress/api/backup-pull/latest" -Headers @{ 'X-Backup-Key' = $key } -OutFile $tmp -PassThru -UseBasicParsing -TimeoutSec 600
  $name = $res.Headers['X-Backup-File']
  if ($name -is [array]) { $name = $name[0] }
  if (-not $name -or $name -notmatch '^flo-backup-nightly-\d{4}-\d{2}-\d{2}\.db$') { throw "Unexpected reply from the POS" }
  if ((Get-Item $tmp).Length -lt 100000) { throw "The backup file is too small" }
  $target = Join-Path $LocalFolder $name
  Move-Item -Force $tmp $target
  Write-Log "Saved $name ($([math]::Round((Get-Item $target).Length / 1MB, 1)) MB)"

  if (Test-Path $DriveFolder) {
    Copy-Item -Force $target (Join-Path $DriveFolder $name)
    Write-Log "Copied to Google Drive"
  } else {
    Write-Log "Google Drive folder not found: only the PC copy was made"
  }

  Get-ChildItem $LocalFolder -Filter 'flo-backup-nightly-*.db' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
}
