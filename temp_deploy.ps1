$timestamp = (Get-Date).ToString('yyyyMMdd_HHmm'); 
$ver = (Get-Content 'client/package.json' | ConvertFrom-Json).version; 
$backupRoot = Join-Path (Get-Item .).Parent.FullName 'BAK'; 
if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot }
$backupPath = Join-Path $backupRoot ('Tienxin_Assistant_' + $timestamp + '_' + $env:COMPUTERNAME); 
New-Item -ItemType Directory -Force -Path $backupPath; 
robocopy 'client/src' (Join-Path $backupPath 'client/src') /E /MT:8 /R:1 /W:1; 
robocopy 'SPEC' (Join-Path $backupPath 'SPEC') /E /MT:8 /R:1 /W:1; 
Copy-Item 'client/package.json' (Join-Path $backupPath 'client/package.json') -Force; 
git add .; 
git commit -m "chore: release v$ver - Update Logic and Alert SOP"; 
git push origin main; 
git tag v$ver; 
git push origin v$ver; 
Write-Host "DEPLOY_SUCCESS: v$ver"
