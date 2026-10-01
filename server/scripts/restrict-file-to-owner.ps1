# Restrict a file to the current Windows account, and verify it.
#
#   powershell -NoProfile -NonInteractive -File restrict-file-to-owner.ps1 -Path <file>
#
# WHY A SEPARATE SCRIPT
# --------------------
# `icacls <file> /inheritance:r /grant:r <user>:F` does NOT do what it looks
# like. Measured on this machine (2026-09-28): after running it, the file
# still carried `(I)(RX,W)` grants for two unrelated SIDs, so it remained
# readable by other local accounts. The flag governs a grant being ADDED,
# not entries already inherited from the parent directory.
#
# `Set-Acl` with `SetAccessRuleProtection($true, $false)` is what actually
# removes inheritance. This lives in a .ps1 rather than inline in the Node
# script because passing a file path to `powershell -Command` alongside
# other arguments does not populate `$args` — the path is parsed as part
# of the command instead, and the ACL is silently never set. A -File
# invocation with an explicit -Path parameter has no such ambiguity.

param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path -LiteralPath $Path).Path

$acl = Get-Acl -LiteralPath $resolved

# Break inheritance and drop everything that came with it. Disabling
# inheritance without removing the copied entries is the trap above.
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRule($rule)
}

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$full = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
$acl.AddAccessRule($full)
Set-Acl -LiteralPath $resolved -AclObject $acl

# Verify the outcome rather than trust it. A file that is still readable
# by another account is a credential exposure, and the caller needs to
# stop rather than continue.
$after = Get-Acl -LiteralPath $resolved
$foreign = @($after.Access | Where-Object { $_.IdentityReference.Value -ne $me })

if ($foreign.Count -gt 0) {
  Write-Error ("ACL still exposes the file to: " + (($foreign | ForEach-Object { $_.IdentityReference.Value }) -join ', '))
  exit 1
}

Write-Output ("ACL restricted to {0} only" -f $me)
exit 0
