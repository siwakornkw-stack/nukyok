param([string]$Dir, [string]$PlanFile, [string]$Ledger)
# Writes the PO + RR (ซื้อเงินเชื่อ) for one repair bill into an Express company folder, the
# way staff key it (see scripts/express/repair.mjs). Built from fuel-write.ps1
# (PO part) and r3-write.ps1 (RR header, journal 04, APMAS / APBAL). The version run on
# TESTR3 2026-11-18 (one bill per VAT mode, plus REPAIR_TEST_FAIL_AT=before-apbal) matched
# RRs keyed by staff. The atomic Save-Ledger, the two-step Append, the RR number taken past every
# table and the flushes were run on TESTR3 2026-11-24 (VAT 0 / 1 / 2 bills against staff RRs,
# before-apbal, the kill hook). That kill showed FLUSH alone left the ISRUN change in memory; the
# second GO after each REPLACE (Change, rollback) fixed it. This version passed the full TESTR3
# run of HANDOFF.md on 2026-11-25 (VAT 0 / 1 / 2 against staff RRs, before-apbal, the kill hook:
# ISRUN's PO counter on disk right after the kill, full undo from the ledger, then ลองใหม่).
#
# Same rules as r3-write.ps1 / fuel-write.ps1: every table opened with INDEX (no
# structural-CDX flag), one small EXECSCRIPT per step on one connection, Thai
# text only as parameters, each appended record and each changed field (with its
# old value) logged to the ledger before the next step, and on any failure the
# appended records are deleted and the changed fields put back.
#
# Prints one line: RESULT:OK:<po>|<rr> | RESULT:EXISTS:<po>|<rr> | RESULT:BUSY:<why> | RESULT:ERR:<message>
#
# Test hooks, for the TESTR3 company only (REPAIR_TEST_FAIL_AT, never set in normal runs):
#   before-apbal  fails with everything but APBAL written: ledger "rolled-back", Express as before the run
#   kill          the process ends after the RR stock line, as a timeout or a power cut would: the ledger
#                 stays "writing" and the agent holds every repair bill; once a person has moved the ledger,
#                 the next RR of that date takes the next number, not the one the stock line holds
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$inv = [Globalization.CultureInfo]::InvariantCulture
$plan = [IO.File]::ReadAllText($PlanFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
$state = [ordered]@{ order = $plan.orderId; invoice = $plan.invoice; dir = $Dir; started = (Get-Date).ToString("s"); status = "writing"; poNo = ""; rrNo = ""; added = @(); changed = @() }
# Atomic: a temp file next to the ledger, flushed to disk, then swapped in. A power cut
# leaves the previous ledger or this one, never a torn or empty file. ([NullString]::Value:
# PowerShell 5.1 passes $null to a .NET string as "", which File.Replace refuses.) A virus
# scanner or backup tool holding the new file for a moment fails the swap: it is tried again.
function Save-Ledger {
  $tmp = "$Ledger.tmp"
  $w = New-Object IO.StreamWriter($tmp, $false, [Text.Encoding]::UTF8)
  try { $w.Write(($state | ConvertTo-Json -Depth 6)); $w.Flush(); $w.BaseStream.Flush($true) } finally { $w.Dispose() }
  for ($i = 1; ; $i++) {
    try {
      if ([IO.File]::Exists($Ledger)) { [IO.File]::Replace($tmp, $Ledger, [NullString]::Value) } else { [IO.File]::Move($tmp, $Ledger) }
      return
    } catch [IO.IOException], [UnauthorizedAccessException] {
      if ($i -ge 40) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

$cn = New-Object System.Data.OleDb.OleDbConnection("Provider=VFPOLEDB.1;Data Source=$Dir;Collating Sequence=MACHINE;")
function Run([string]$body, [object[]]$params = @()) {
  $names = (1..[Math]::Max(1, $params.Count) | ForEach-Object { "p$_" }) -join ", "
  $c = $cn.CreateCommand()
  $c.CommandText = "EXECSCRIPT(" + ((0..[Math]::Max(1, $params.Count) | ForEach-Object { "?" }) -join ", ") + ")"
  [void]$c.Parameters.AddWithValue("s", "LPARAMETERS " + $names + "`r`n" + $body)
  if ($params.Count -eq 0) { [void]$c.Parameters.AddWithValue("x", "") }
  $i = 0; foreach ($v in $params) { [void]$c.Parameters.AddWithValue("v$i", [string]$v); $i++ }
  return [string]$c.ExecuteScalar()
}
# VFP date from a "YYYYMMDD" parameter.
function D([string]$p) { "DATE(VAL(LEFT($p, 4)), VAL(SUBSTR($p, 5, 2)), VAL(RIGHT($p, 2)))" }
function N2([double]$n) { $n.ToString("F2", $inv) }
# YOUREF "<job> <plate>" cut to the field, the plate kept whole (job in parameter $j, plate in $p).
function Youref([string]$j, [string]$p) { "IIF(EMPTY(ALLTRIM($p)), LEFT(ALLTRIM($j), LEN(fwap.youref)), LEFT(ALLTRIM($j), MAX(LEN(fwap.youref) - LEN(ALLTRIM($p)) - 1, 0)) + ' ' + ALLTRIM($p))" }

# Each step that writes ends with FLUSH IN <alias> FORCE (the rollback's too), and a step that
# REPLACEs a field of an existing row (Change, the rollback's) then goes back to that row (GO again).
# The provider keeps a change to a row its connection holds locked in memory until the record pointer
# is set again, unlock or close, and FLUSH alone does not write it: a killed write lost the ISRUN /
# STMAS changes its ledger listed, flushed or not (TESTR3 2026-11-24). With the second GO they are on
# disk and the row stays locked (scratch copies of TESTR3's tables, 2026-11-25). So all the ledger
# lists is on disk but perhaps its last entry (logged just before its step).
# Append one record; its record number goes to the ledger before its fields are
# filled, so a failing REPLACE leaves no row the rollback does not know about.
function Append([string]$alias, [string]$assign, [object[]]$params) {
  if ($env:REPAIR_TEST_FAIL_AT -eq "kill" -and $alias -eq "fwgj") { [Environment]::Exit(1) } # test hook (see the top)
  $r = [int](Run "SELECT $alias`r`nAPPEND BLANK`r`nFLUSH IN $alias FORCE`r`nRETURN TRANSFORM(RECNO('$alias'))")
  $state.added += , @($alias, $r); Save-Ledger
  [void](Run ("GO $r IN $alias`r`nREPLACE $assign IN $alias`r`nFLUSH IN $alias FORCE`r`nRETURN 'ok'") $params)
  return $r
}
# Change one field of one record; the old value goes to the ledger first.
# $expr is the new value, written with p4... for $params (p1 recno, p2 alias, p3 field).
function Change([string]$alias, [int]$recno, [string]$field, [string]$expr, [object[]]$params = @()) {
  $old = Run "GO VAL(p1) IN (p2)`r`nLOCAL t, v`r`nt = TYPE(p2 + '.' + p3)`r`nv = EVALUATE(p2 + '.' + p3)`r`nRETURN t + '|' + ICASE(t `$ 'NBYIF', STR(v, 25, 10), t = 'D', DTOS(v), t = 'L', IIF(v, 'T', 'F'), v)" @($recno, $alias, $field)
  $state.changed += , [ordered]@{ alias = $alias; recno = $recno; field = $field; old = $old }; Save-Ledger
  [void](Run ("GO VAL(p1) IN (p2)`r`nREPLACE (p3) WITH $expr IN (p2)`r`nGO VAL(p1) IN (p2)`r`nFLUSH IN (p2) FORCE`r`nRETURN 'ok'") (@($recno, $alias, $field) + $params))
}

$date = ([string]$plan.date) -replace "-", ""
$hasVat = [double]$plan.vat -gt 0
$vatrat = if ($plan.flgvat -eq "0") { "0" } else { "7" }
$result = ""
$tables = @(@("popr", "fwpo"), @("poprit", "fwpi"), @("isrun", "fwrn"), @("aptrn", "fwap"), @("stcrd", "fwst"),
  @("gljnl", "fwgj"), @("gljnlit", "fwgi"), @("isvat", "fwvt"), @("apbal", "fwab"), @("apmas", "fwam"))

try {
  $cn.Open()
  Save-Ledger
  $open = "SET DELETED OFF`r`nSET EXACT OFF`r`nSET REPROCESS TO 5 SECONDS`r`n"
  foreach ($t in $tables) { $open += "USE $($t[0]) INDEX $($t[0]) SHARED IN 0 ALIAS $($t[1])`r`n" }
  [void](Run ($open + "RETURN 'ok'"))

  # Already in Express? (staff may have keyed this bill, or an earlier run wrote it).
  # Same rule as repair.mjs: same invoice, supplier and amount, dated within 90 days of the bill.
  $rr = Run ("SELECT fwap`r`nLOCATE FOR rectyp == '3' AND LEFT(docnum, 2) == 'RR' AND ALLTRIM(refnum) == ALLTRIM(p2) AND supcod == PADR(p1, LEN(supcod)) AND docstat # 'C' AND NOT DELETED() AND " +
    "ROUND(netamt, 2) = ROUND(VAL(p3), 2) AND NOT EMPTY(docdat) AND ABS(docdat - $(D 'p4')) <= 90`r`nRETURN IIF(FOUND(), ALLTRIM(fwap.docnum) + '|' + ALLTRIM(fwap.ponum), '')") @(
    $plan.supplier.code, $plan.invoice, (N2 $plan.total), $date)
  if ($rr) { $p = $rr.Split("|"); $state.status = "exists"; $state.rrNo = $p[0]; $state.poNo = $p[1]; Save-Ledger; $result = "EXISTS:$($p[1])|$($p[0])"; return }

  # Lock every existing row this write changes before writing anything.
  $run = Run "SELECT fwrn`r`nLOCATE FOR doctyp == 'PO' AND prefix == PADR(p1, LEN(prefix)) AND NOT DELETED()`r`nIF NOT FOUND()`r`nRETURN 'NOTFOUND'`r`nENDIF`r`nRETURN IIF(RLOCK('fwrn'), TRANSFORM(RECNO('fwrn')), 'LOCKED')" @($plan.poPrefix)
  if ($run -eq "NOTFOUND") { throw "ไม่พบเลขรันของ $($plan.poPrefix) ใน ISRUN" }
  $mas = Run "SELECT fwam`r`nLOCATE FOR supcod == PADR(p1, LEN(supcod)) AND NOT DELETED()`r`nIF NOT FOUND()`r`nRETURN 'NOTFOUND'`r`nENDIF`r`nRETURN IIF(RLOCK('fwam'), TRANSFORM(RECNO('fwam')), 'LOCKED')" @($plan.supplier.code)
  $bal = Run "SELECT fwab`r`nLOCATE FOR supcod == PADR(p1, LEN(supcod)) AND NOT DELETED()`r`nIF NOT FOUND()`r`nRETURN 'NOTFOUND'`r`nENDIF`r`nRETURN IIF(RLOCK('fwab'), TRANSFORM(RECNO('fwab')), 'LOCKED')" @($plan.supplier.code)
  if ($mas -eq "NOTFOUND" -or $bal -eq "NOTFOUND") { throw "ไม่พบผู้จำหน่าย $($plan.supplier.code) ใน APMAS/APBAL" }
  if ($run -eq "LOCKED" -or $mas -eq "LOCKED" -or $bal -eq "LOCKED") {
    $state.status = "busy"; Save-Ledger; $result = "BUSY:มีคนกำลังแก้ข้อมูลที่ต้องใช้ใน Express (เลขรัน PO / ผู้จำหน่าย)"; return
  }

  # ---- PO, written as already received (DOCSTAT M, REMQTY 0): its RR follows in this run ----
  # Next number from ISRUN ("0000123"), at the counter's own width, skipping any already in POPR.
  $poNo = Run "LOCAL n, c, w`r`nGO VAL(p1) IN fwrn`r`nn = VAL(ALLTRIM(fwrn.docnum))`r`nw = MAX(LEN(ALLTRIM(fwrn.docnum)), 1)`r`nSELECT fwpo`r`nDO WHILE .T.`r`nc = p2 + PADL(TRANSFORM(n), w, '0')`r`nLOCATE FOR ponum == PADR(c, LEN(ponum))`r`nIF NOT FOUND()`r`nEXIT`r`nENDIF`r`nn = n + 1`r`nENDDO`r`nRETURN c" @($run, $plan.poPrefix)
  $state.poNo = $poNo; Save-Ledger
  [void](Append "fwpo" ("porectyp WITH '0', ponum WITH p2, podat WITH $(D 'p1'), flgvat WITH p3, depcod WITH p4, supcod WITH p5, paytrm WITH 0, " +
    "rcvdat WITH $(D 'p1'), nxtseq WITH '  1', amount WITH VAL(p6), total WITH VAL(p6), vatrat WITH VAL(p7), vatamt WITH VAL(p8), netamt WITH VAL(p9), " +
    "netval WITH VAL(p10), cmpldat WITH $(D 'p1'), docstat WITH 'M', userid WITH p11, chgdat WITH DATE(), orgnum WITH VAL(p12)") @(
    $date, $poNo, $plan.flgvat, $plan.dep, $plan.supplier.code, (N2 $plan.price), $vatrat, (N2 $plan.vat), (N2 $plan.total), (N2 $plan.net), $plan.user, [string]$plan.supplier.branch))
  [void](Append "fwpi" ("porectyp WITH '0', ponum WITH p2, seqnum WITH '  1', rcvdat WITH $(D 'p1'), supcod WITH p3, stkcod WITH p4, loccod WITH '-', " +
    "stkdes WITH p5, depcod WITH p6, ordqty WITH 1, remqty WITH 0, tfactor WITH 1, unitpr WITH VAL(p7), tqucod WITH p8, trnval WITH VAL(p7)") @(
    $date, $poNo, $plan.supplier.code, $plan.item.code, $plan.item.desc, $plan.dep, (N2 $plan.price), $plan.item.unit))
  $n = Run "LOCAL n`r`nSELECT fwpo`r`nCOUNT FOR ponum == PADR(p1, LEN(ponum)) AND NOT DELETED() TO n`r`nRETURN TRANSFORM(n)" @($poNo)
  if ($n -ne "1") { throw "เลขที่ $poNo ซ้ำ ($n ใบ)" }
  Change "fwrn" ([int]$run) "docnum" "PADR(PADL(TRANSFORM(VAL(SUBSTR(p4, LEN(p5) + 1)) + 1), LEN(p4) - LEN(p5), '0'), LEN(fwrn.docnum))" @($poNo, $plan.poPrefix)

  # ---- RR ----
  # Next RR<BEyymmdd>-NN past every number the tables of this write hold, deleted rows too (numbers
  # are never reused). The header goes in last: a write cut off part way leaves stock, journal and
  # VAT rows under its number with no APTRN row, and the next bill must not merge with them.
  $scan = ""
  foreach ($f in @(@("fwap", "docnum"), @("fwst", "docnum"), @("fwgj", "voucher"), @("fwgi", "voucher"), @("fwvt", "docnum"))) {
    $scan += "SELECT $($f[0])`r`nSCAN FOR LEFT($($f[1]), LEN(p1)) == p1`r`nn = MAX(n, VAL(SUBSTR($($f[1]), LEN(p1) + 1, 2)))`r`nENDSCAN`r`n"
  }
  $rrNo = Run ("LOCAL n`r`nn = 0`r`n" + $scan + "RETURN IIF(n >= 99, '', p1 + PADL(TRANSFORM(n + 1), 2, '0'))") @($plan.rrPrefix)
  if (-not $rrNo) { throw "เลขที่ RR ของวันนี้เต็ม (99)" }
  $state.rrNo = $rrNo; Save-Ledger

  [void](Append "fwst" ("stkcod WITH p3, loccod WITH '-', docnum WITH p2, seqnum WITH '  1', docdat WITH $(D 'p1'), rdocnum WITH PADR(p4, 12) + '  1', " +
    "depcod WITH p5, posopr WITH '0', people WITH p6, trnqty WITH 1, tqucod WITH p7, tfactor WITH 1, unitpr WITH VAL(p8), trnval WITH VAL(p8), " +
    "xtrnqty WITH 1, xunitpr WITH VAL(p9), xtrnval WITH VAL(p9), xsalval WITH VAL(p9), netval WITH VAL(p9), stkdes WITH p10") @(
    $date, $rrNo, $plan.item.code, $poNo, $plan.dep, $plan.supplier.code, $plan.item.unit, (N2 $plan.price), (N2 $plan.net), $plan.item.desc))
  # Journal 04 (ISRUN JNLEXP: SUPNAM ':' YOUREF): Dr the item's account, Dr VAT, Cr the creditor.
  [void](Append "fwgj" ("jnltyp WITH '04', voudat WITH $(D 'p1'), voucher WITH p2, descrp WITH LEFT(ALLTRIM(p3) + ':' + $(Youref 'p4' 'p5'), LEN(fwgj.descrp)), " +
    "trnstat WITH 'P', docstat WITH 'N', creby WITH p6, credat WITH DATE(), userid WITH p6, chgdat WITH DATE()") @(
    $date, $rrNo, $plan.supplier.name, $plan.job, $plan.plate, $plan.user))
  $time = (Get-Date).ToString("HHmm")
  $lines = @(, @(" 0", $plan.accounts.expense, "0", $plan.net))
  if ($hasVat) { $lines += , @(" 3", $plan.accounts.vat, "0", $plan.vat) }
  $lines += , @(" 6", $plan.accounts.pay, "1", $plan.total)
  foreach ($g in $lines) {
    [void](Append "fwgi" ("voucher WITH p2, seqit WITH p3, voudat WITH $(D 'p1'), accnum WITH p4, depcod WITH p5, " +
      "descrp WITH LEFT(ALLTRIM(p6) + ':' + $(Youref 'p7' 'p8'), LEN(fwgi.descrp)), trntyp WITH p9, amount WITH VAL(p10), chgdat WITH DATE(), chgtim WITH p11") @(
      $date, $rrNo, $g[0], $g[1], $plan.dep, $plan.supplier.name, $plan.job, $plan.plate, $g[2], (N2 ([double]$g[3])), $time))
  }
  if ($hasVat) {
    [void](Append "fwvt" ("vatrec WITH 'P', rectyp WITH '3', vatprd WITH DATE(YEAR($(D 'p1')), MONTH($(D 'p1')), 1), vatdat WITH $(D 'p1'), docdat WITH $(D 'p1'), " +
      "docnum WITH p2, refnum WITH p3, depcod WITH p4, descrp WITH p5, amt01 WITH VAL(p6), vat01 WITH VAL(p7), self_added WITH 'N', had_modify WITH 'N', " +
      "docstat WITH 'Y', taxid WITH p8, orgnum WITH VAL(p9), prenam WITH p10") @(
      $date, $rrNo, $plan.invoice, $plan.dep, $plan.supplier.name, (N2 $plan.net), (N2 $plan.vat), $plan.supplier.taxId, [string]$plan.supplier.branch, $plan.supplier.prenam))
  }
  [void](Append "fwap" ("rectyp WITH '3', docnum WITH p2, docdat WITH $(D 'p1'), refnum WITH p3, vatprd WITH DATE(YEAR($(D 'p1')), MONTH($(D 'p1')), 1), " +
    "ponum WITH p4, depcod WITH p5, flgvat WITH p6, supcod WITH p7, youref WITH $(Youref 'p8' 'p9'), paytrm WITH 0, duedat WITH $(D 'p1'), bilnum WITH '~', " +
    "nxtseq WITH '  1', amount WITH VAL(p10), aftdisc WITH VAL(p10), total WITH VAL(p10), vatrat WITH VAL(p11), vatamt WITH VAL(p12), netamt WITH VAL(p13), " +
    "netval WITH VAL(p14), remamt WITH VAL(p13), cmplapp WITH 'N', docstat WITH 'N', vatdat WITH $(D 'p1'), srv_vattyp WITH IIF(VAL(p12) > 0, '1', '-'), " +
    "pvatprorat WITH '-', userid WITH p15, chgdat WITH DATE(), orgnum WITH VAL(p16)") @(
    $date, $rrNo, $plan.invoice, $poNo, $plan.dep, $plan.flgvat, $plan.supplier.code, $plan.job, $plan.plate,
    (N2 $plan.price), $vatrat, (N2 $plan.vat), (N2 $plan.total), (N2 $plan.net), $plan.user, [string]$plan.supplier.branch))
  $n = Run "LOCAL n`r`nSELECT fwap`r`nCOUNT FOR docnum == PADR(p1, LEN(docnum)) AND NOT DELETED() TO n`r`nRETURN TRANSFORM(n)" @($rrNo)
  if ($n -ne "1") { throw "เลขที่ $rrNo ซ้ำ ($n ใบ)" }

  # Creditor balance + last receive date, then the period purchases (APBAL).
  Change "fwam" ([int]$mas) "balance" "fwam.balance + VAL(p4)" @((N2 $plan.total))
  Change "fwam" ([int]$mas) "lasrcv" "IIF(EMPTY(fwam.lasrcv) OR fwam.lasrcv < $(D 'p4'), $(D 'p4'), fwam.lasrcv)" @($date)
  # Test hook (never set in normal runs): fail with everything but APBAL written,
  # to prove the rollback restores rows, text, date and number fields.
  if ($env:REPAIR_TEST_FAIL_AT -eq "before-apbal") { [void](Run "USE repair_test_no_such_table IN 0`r`nRETURN 'x'") }
  Change "fwab" ([int]$bal) ([string]$plan.balColumn) "EVALUATE('fwab.' + p3) + VAL(p4)" @((N2 $plan.total))

  $state.status = "done"; Save-Ledger
  $result = "OK:$poNo|$rrNo"
} catch {
  $err = $_.Exception.Message
  try {
    if ($cn.State -eq "Open") {
      $added = @($state.added); [array]::Reverse($added)
      foreach ($a in $added) { [void](Run "GO VAL(p2) IN (p1)`r`nDELETE IN (p1)`r`nFLUSH IN (p1) FORCE`r`nRETURN 'ok'" @($a[0], $a[1])) }
      $changed = @($state.changed); [array]::Reverse($changed)
      foreach ($c in $changed) {
        $t = $c.old.Substring(0, 1); $v = $c.old.Substring(2)
        $expr = switch ($t) { "D" { "IIF(EMPTY(p4), {}, $(D 'p4'))" } "L" { "p4 == 'T'" } "C" { "p4" } default { "VAL(p4)" } }
        [void](Run ("GO VAL(p1) IN (p2)`r`nREPLACE (p3) WITH $expr IN (p2)`r`nGO VAL(p1) IN (p2)`r`nFLUSH IN (p2) FORCE`r`nRETURN 'ok'") @($c.recno, $c.alias, $c.field, $v))
      }
      $state.status = "rolled-back"
    } else { $state.status = "failed-unopened" }
  } catch {
    $state.status = "ROLLBACK-FAILED"
    $err = "$err | ย้อนกลับไม่สำเร็จ: $($_.Exception.Message)"
  }
  $state.error = $err
  $result = "ERR:$err"
  # The ledger still says writing when this save fails: the message says how far the rollback got.
  try { Save-Ledger } catch {
    $done = if ($state.status -eq "rolled-back") { " แต่ย้อนกลับใน Express ครบแล้ว" } else { "" }
    $result = "ERR:$err | บันทึก ledger ไม่สำเร็จ ($($_.Exception.Message))$done"
  }
} finally {
  if ($cn.State -eq "Open") {
    $close = "UNLOCK ALL`r`n"
    foreach ($t in $tables) { $close += "IF USED('$($t[1])')`r`nUSE IN $($t[1])`r`nENDIF`r`n" }
    try { [void](Run ($close + "RETURN 'ok'")) } catch {}
    $cn.Close()
  }
  "RESULT:" + $result
}
