# 打包 skill 并发布到本机 sync-service
# Usage: .\tools\publish-skill.ps1 -Version "2026.06.15.1" -Root "..\ai-for-china-legal"
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Root = (Join-Path $PSScriptRoot "..\vendor\ai-for-china-legal"),
  [string]$Channel = "stable",
  [string]$Notes = ""
)

$repoRoot = Split-Path $PSScriptRoot -Parent
node (Join-Path $PSScriptRoot "publish-skill.mjs") `
  --root $Root `
  --version $Version `
  --channel $Channel `
  --notes $Notes `
  --sync-data (Join-Path $repoRoot "tools\sync-service\data")
