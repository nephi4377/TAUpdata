@echo off
setlocal
chcp 65001 > nul

:: =================================================================
::               添心設計：生產力助手部署腳本 v2.1 (Stable)
:: =================================================================

echo.
echo [Step 1/2] 執行專案備份 (至 BAK 目錄)...
set "SOURCE_DIR=%~dp0"
set "BACKUP_ROOT=%~dp0..\BAK"

:: 獲取時間戳記
for /f "delims=" %%i in ('powershell -Command "(Get-Date).ToString('yyyyMMdd_HHmm')"') do set "TIMESTAMP=%%i"
set "BACKUP_FOLDER_NAME=Tienxin_Assistant_%TIMESTAMP%_%COMPUTERNAME%"
set "BACKUP_PATH=%BACKUP_ROOT%\%BACKUP_FOLDER_NAME%"

mkdir "%BACKUP_PATH%" 2>nul

:: 使用 robocopy 進行更穩定的備份，排除 node_modules, .git 等
robocopy "%SOURCE_DIR%client\src" "%BACKUP_PATH%\client\src" /E /MT:8 /R:1 /W:1 > nul
robocopy "%SOURCE_DIR%SPEC" "%BACKUP_PATH%\SPEC" /E /MT:8 /R:1 /W:1 > nul
copy "%SOURCE_DIR%client\package.json" "%BACKUP_PATH%\client\package.json" > nul 2>&1

echo    - 備份路徑: %BACKUP_PATH%
echo    - 備份完成。

echo.
echo [Step 2/2] 推送熱更新至雲端 (GitHub)...
cd /d "%SOURCE_DIR%"

:: 檢查 Git 狀態
git add .

:: 提取版本號 (從 package.json)
for /f "delims=" %%i in ('powershell -Command "(Get-Content 'client/package.json' | ConvertFrom-Json).version"') do set "VER=%%i"

echo    - 目前版本: %VER% (部署時間: %TIMESTAMP%)
git commit -m "chore: release v%VER% (Localized & Hourly Sync)"
git push origin main
git tag v%VER%
git push origin v%VER%

echo.
echo ==================================================================
echo   任務結束！版本: %VER% (部署完畢)
echo ==================================================================
pause
