# Installs / updates the nukyok Express agent on the office PC that holds the Express data.
# Start it with install.cmd (asks for admin). Safe to run again: the current settings are the defaults
# (fuel is always offered as y), so re-running is also how a new version is installed or a mode is switched on.
#   C:\nukyok-agent\           scripts, .env, run.cmd, var\agent.log
#   Task "nukyok-express-agent" runs run.cmd every minute (SYSTEM; the user for an Express folder on a share)
$ErrorActionPreference = 'Stop'
$Target = 'C:\nukyok-agent'
$Task = 'nukyok-express-agent'
$src = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false

function Fail($m) { Write-Host ""; Write-Host $m -ForegroundColor Red; Read-Host 'กด Enter เพื่อปิด' | Out-Null; exit 1 }
function Ask($q, $def) { $a = Read-Host "$q [$def]"; if ($a) { $a.Trim() } else { $def } }
function YesNo($q, $def) { (Ask "$q (y/n)" $(if ($def) { 'y' } else { 'n' })) -match '^[yY]' }
function ReadEnv($f) {
  $h = @{}
  if (Test-Path $f) { foreach ($l in [IO.File]::ReadAllLines($f)) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $h[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") } } }
  $h
}

Write-Host '== ติดตั้งตัวเชื่อม nukyok -> Express ==' -ForegroundColor Cyan
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'ต้องรันด้วยสิทธิ์ Administrator: ดับเบิลคลิก install.cmd' }

# 1. Node.js 22+ (installed for all users: the task runs as SYSTEM)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'ยังไม่มี Node.js: ติดตั้ง Node.js 22 LTS จาก https://nodejs.org (ค่าเริ่มต้นทั้งหมด) แล้วรัน install.cmd ใหม่' }
$ver = & $node -v
if ([int]($ver -replace '^v(\d+).*', '$1') -lt 22) { Fail "Node.js $ver เก่าไป ต้องเป็นรุ่น 22 ขึ้นไป (https://nodejs.org)" }
if ($node -match '[^\x20-\x7E]') { Fail "Node.js อยู่ในโฟลเดอร์ที่มีภาษาไทย ($node): ติดตั้งใหม่แบบ all users (C:\Program Files\nodejs)" }
$ps32 = "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $ps32)) { Fail 'ไม่พบ PowerShell 32-bit (ต้องเป็น Windows 64-bit)' }
Write-Host "Node.js $ver  OK"

# 2. Settings: the installed .env first, then the server address + secret this package came with
$cur = ReadEnv (Join-Path $Target '.env')
$pkg = ReadEnv (Join-Path $src '.env')
foreach ($k in 'EXPRESS_SYNC_URL', 'EXPRESS_SYNC_SECRET') { if ($pkg[$k]) { $cur[$k] = $pkg[$k] } }
if (-not $cur.EXPRESS_SYNC_URL) { $cur.EXPRESS_SYNC_URL = 'https://nukyok.phuketnukyok.com' }
if (-not $cur.EXPRESS_SYNC_SECRET) { $cur.EXPRESS_SYNC_SECRET = Read-Host 'EXPRESS_SYNC_SECRET (ค่าเดียวกับบนเซิร์ฟเวอร์)' }
if (-not $cur.EXPRESS_SYNC_SECRET) { Fail 'ต้องมี EXPRESS_SYNC_SECRET' }

# 3. The Express company folder (holds POPR.DBF): offer the ones found under folders named *express*
Write-Host ''
Write-Host 'กำลังหาโฟลเดอร์บริษัทใน Express...'
$found = @()
foreach ($root in (Get-PSDrive -PSProvider FileSystem | Where-Object { $null -ne $_.Free }).Root) {
  foreach ($d in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object Name -match 'express')) {
    $found += Get-ChildItem $d.FullName -Filter POPR.DBF -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { $_.DirectoryName }
  }
}
$found = @($found | Sort-Object -Unique)
for ($i = 0; $i -lt $found.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $found[$i]) }
if (-not $found.Count) { Write-Host '  (ไม่พบ พิมพ์ path เอง)' }
Write-Host 'ครั้งแรกให้เลือกบริษัททดสอบ (TESTR3) ก่อน ตรวจผลใน Express แล้วค่อยรันใหม่เลือกบริษัทจริง' -ForegroundColor Yellow
$def = if ($cur.EXPRESS_DIR) { $cur.EXPRESS_DIR } elseif ($found.Count -eq 1) { $found[0] } else { '' }
$a = Ask 'โฟลเดอร์บริษัท (เลขในรายการ หรือพิมพ์ path)' $def
if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $found.Count) { $a = $found[[int]$a - 1] }
# an elevated window does not see the user's mapped drives (Z:): a folder on another PC is typed as \\PC\share\...
if (-not $a -or -not (Test-Path (Join-Path $a 'POPR.DBF'))) { Fail "ไม่พบ POPR.DBF ใน '$a': ต้องเป็นโฟลเดอร์ของบริษัทใน Express (ถ้าอยู่บนเครื่องอื่น พิมพ์แบบ \\ชื่อเครื่อง\โฟลเดอร์ ไดรฟ์ที่แมปไว้เช่น Z: ใช้ที่นี่ไม่ได้)" }
$dir = (Resolve-Path $a).ProviderPath.TrimEnd('\')
# a mapped drive (Z:) does not exist for the task: use the share's own address
$drv = if ($dir -match '^[A-Za-z]:') { Get-PSDrive -Name $dir.Substring(0, 1) -ErrorAction SilentlyContinue }
if ($drv.DisplayRoot -like '\\*') { $dir = $drv.DisplayRoot.TrimEnd('\') + $dir.Substring(2) }
if ($dir -match "'") { Fail "path มีเครื่องหมาย ' ใช้ไม่ได้: $dir" }

# 4. Writing needs the 32-bit VFP OLE DB provider; without it the agent only reads (modes stay off)
# try/catch inside: a failed Open() alone would not stop the next statement from printing VFP-OK
$probe = "try { `$c = New-Object System.Data.OleDb.OleDbConnection('Provider=VFPOLEDB.1;Data Source=$dir;'); `$c.Open(); `$c.Close(); 'VFP-OK' } catch { 'VFP-NO ' + `$_.Exception.Message }"
$out = & $ps32 -NoProfile -Command $probe
$oledb = @($out | ForEach-Object { "$_".Trim() }) -contains 'VFP-OK'
if ($oledb) { Write-Host 'VFP OLE DB Provider  OK' }
else {
  Write-Host 'ยังไม่มี VFP OLE DB Provider 9.0 SP2 (32-bit): ตอนนี้อ่านข้อมูลจาก Express ได้อย่างเดียว ยังเขียนไม่ได้' -ForegroundColor Yellow
  Write-Host "  ($((@($out) -join ' ').Trim()))" -ForegroundColor Yellow
  Write-Host '  ติดตั้ง VFPOLEDBSetup.msi จาก https://github.com/VFPX/VFPInstallers แล้วรัน install.cmd ใหม่เพื่อเปิดการเขียน' -ForegroundColor Yellow
}

# 5. What to write automatically
Write-Host ''
$fuel = $false; $repair = $false
if ($oledb) {
  # offered as y every time: an "off" left by a run without the provider must not stick
  $fuel = YesNo 'ลง Express อัตโนมัติ: น้ำมัน PK / H3 / R3 เมื่อ Office อนุมัติ' $true
  $repair = YesNo 'ลง Express อัตโนมัติ: งานซ่อม PO / RR (ซื้อเงินเชื่อ) เมื่อจัดซื้อบันทึกค่าซ่อม' ($cur.EXPRESS_REPAIR_MODE -eq 'live')
}
$prefix = if ($cur.EXPRESS_REPAIR_PO_PREFIX) { $cur.EXPRESS_REPAIR_PO_PREFIX } else { 'PO' }
if ($repair) { $prefix = Ask 'เล่มใบสั่งซื้อที่ใช้กับงานซ่อม' $prefix }
$mode = { param($on) if ($on) { 'live' } else { 'off' } }

# 6. Files
New-Item -ItemType Directory -Force "$Target\scripts\express", "$Target\var" | Out-Null
if ((Resolve-Path $src).ProviderPath.TrimEnd('\') -ne $Target) {
  Copy-Item "$src\scripts\*" "$Target\scripts" -Recurse -Force
  Copy-Item "$src\install.cmd", "$src\install.ps1", "$src\README-TH.txt" $Target -Force
}
Get-ChildItem $Target -Recurse -File | Unblock-File
# single quotes: Node reads \n inside double quotes as a new line (D:\Express\nukyok)
$lines = @(
  "EXPRESS_DIR='$dir'",
  "EXPRESS_SYNC_URL='$($cur.EXPRESS_SYNC_URL)'",
  "EXPRESS_SYNC_SECRET='$($cur.EXPRESS_SYNC_SECRET)'",
  "EXPRESS_FUEL_MODE=$(& $mode $fuel)",
  "EXPRESS_REPAIR_MODE=$(& $mode $repair)",
  "EXPRESS_R3_MODE=$(& $mode $fuel)",
  "EXPRESS_REPAIR_PO_PREFIX='$prefix'"
)
[IO.File]::WriteAllText("$Target\.env", ($lines -join "`r`n") + "`r`n", $utf8)
# ponytail: one old log kept at 5 MB; the agent writes a line only when it did something
$run = @(
  '@echo off',
  'cd /d "%~dp0"',
  'for %%F in (var\agent.log) do if %%~zF GTR 5000000 move /y var\agent.log var\agent.old.log >nul',
  "`"$node`" --env-file=.env scripts\express-agent.mjs >> var\agent.log 2>&1"
)
[IO.File]::WriteAllText("$Target\run.cmd", ($run -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)

# 7. One read-only run now: sends the master data, writes nothing (the environment beats .env)
Write-Host ''
Write-Host 'ทดสอบเชื่อมต่อกับเว็บ...'
Remove-Item "$Target\var\express-agent.json", "$Target\var\express-agent.lock" -ErrorAction SilentlyContinue
$env:EXPRESS_FUEL_MODE = 'off'; $env:EXPRESS_REPAIR_MODE = 'off'; $env:EXPRESS_R3_MODE = 'off'
Push-Location $Target
$ErrorActionPreference = 'Continue'
$test = (& $node --env-file=.env scripts\express-agent.mjs 2>&1) -join "`n"
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Pop-Location
Remove-Item Env:\EXPRESS_FUEL_MODE, Env:\EXPRESS_REPAIR_MODE, Env:\EXPRESS_R3_MODE
Write-Host $test
if ($code -ne 0 -or $test -notmatch 'masters sent') { Fail 'ส่งข้อมูลไปเว็บไม่สำเร็จ: ตรวจอินเทอร์เน็ต และ EXPRESS_SYNC_SECRET ให้ตรงกับเซิร์ฟเวอร์' }

# 8. Every minute from now on, also after a restart and while nobody is logged in
$action = New-ScheduledTaskAction -Execute "$Target\run.cmd" -WorkingDirectory $Target
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
if ($dir.StartsWith('\\')) {
  # SYSTEM cannot open a share: run as this Windows user (Windows asks for its password once)
  Write-Host 'Express อยู่บนเครื่องอื่นในวงแลน: ใส่รหัสผ่าน Windows ของผู้ใช้นี้ เพื่อให้รันได้แม้ไม่ได้ล็อกอิน'
  $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'รหัสผ่าน Windows ของผู้ใช้นี้'
  Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
} else {
  Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
}

# 9. One run by the task itself: SYSTEM (or that user) must reach Express and the web too, not only this window
Write-Host ''
Write-Host 'ทดสอบรันจาก Task Scheduler...'
Remove-Item "$Target\var\express-agent.json" -ErrorAction SilentlyContinue  # so that run sends the master data again
$t0 = (Get-Date).AddSeconds(-1)
Start-ScheduledTask -TaskName $Task
# 267009 = running, 267011 = has not run yet
do { Start-Sleep 2; $info = Get-ScheduledTaskInfo -TaskName $Task }
while (($info.LastTaskResult -in @(267009, 267011) -or $info.LastRunTime -lt $t0) -and (Get-Date) -lt $t0.AddSeconds(120))
$tail = Get-Content "$Target\var\agent.log" -Tail 3 -Encoding UTF8 -ErrorAction SilentlyContinue | Out-String
if ($info.LastTaskResult -eq 0) { Write-Host $tail }
elseif ($info.LastTaskResult -eq 267009) { Write-Host 'ยังรันอยู่ (ข้อมูล Express เยอะ) ดูผลใน log ภายหลัง' -ForegroundColor Yellow }
else { Write-Host $tail; Fail "ติดตั้งแล้ว แต่รันจาก Task Scheduler ไม่ผ่าน (รหัส $($info.LastTaskResult)): ส่งข้อความข้างบนและไฟล์ $Target\var\agent.log ให้ผู้ดูแลระบบ" }

Write-Host ''
Write-Host '== ติดตั้งเสร็จ ==' -ForegroundColor Green
Write-Host "บริษัท:       $dir"
Write-Host "น้ำมัน:        $(& $mode $fuel)    งานซ่อม: $(& $mode $repair)    R3: $(& $mode $fuel)"
Write-Host "ทำงานทุก 1 นาที (Task Scheduler: $Task)  log: $Target\var\agent.log"
Write-Host "ดูสถานะในเว็บ: $($cur.EXPRESS_SYNC_URL)/office/express"
Read-Host 'กด Enter เพื่อปิด' | Out-Null
