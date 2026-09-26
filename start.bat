@echo off
cd /d "%~dp0"
start "PersiaSSH" "%~dp0node_modules\electron\dist\electron.exe" .
exit
