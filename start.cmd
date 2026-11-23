@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 launch.py
goto finished
:usepython
python launch.py
:finished
if errorlevel 1 pause
