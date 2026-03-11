@echo off
setlocal
chcp 65001 > nul

:: =================================================================
::               添心設計：生產力助手部署腳本 v2.0 (Hotfix 版)
:: =================================================================
:: 1. 執行精確路徑備份 (排除 node_modules 與 .git)
:: 2. 自動同步至 GitHub main 分支，觸發熱更新
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
if errorlevel 1 (
    echo    - 警告: 無法建立備份目錄，請檢查權限。
) else (
    REM 執行備份，排除大體積與冗餘資料
    echo    - 正在備份至: %BACKUP_PATH%...
    xcopy "%SOURCE_DIR%*" "%BACKUP_PATH%\" /E /I /Y /EXCLUDE:%SOURCE_DIR%client\exclude_list.txt > nul 2>&1
    if errorlevel 1 (
        :: 若無排除清單，則簡單備份源碼
        xcopy "%SOURCE_DIR%client\src\*" "%BACKUP_PATH%\client\src\" /E /I /Y > nul
        xcopy "%SOURCE_DIR%SPEC\*" "%BACKUP_PATH%\SPEC\" /E /I /Y > nul
    )
    echo    - 備份完成。
)

echo.
echo [Step 2/2] 推送熱更新至雲端 (GitHub)...
cd /d "%SOURCE_DIR%"

:: 檢查 Git 狀態
git add .

:: 提取版本號 (從 package.json)
for /f "delims=" %%i in ('powershell -Command "(Get-Content 'client/package.json' | ConvertFrom-Json).version"') do set "VER=%%i"

echo    - 目前版本: %VER% (部署時間: %TIMESTAMP%)
git commit -m "feat(hotfix): %VER% - UID Filter, De-spam, Formula Stable at %TIMESTAMP%"
git push origin main

echo.
echo ==================================================================
echo  >> 熱更新部署結束！版本: %VER% <<
echo ==================================================================
pause
