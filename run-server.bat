@echo off
cd /d "%~dp0"
echo Откройте в браузере: http://127.0.0.1:8765/
echo Нажмите Ctrl+C чтобы остановить сервер.
python -m http.server 8765
