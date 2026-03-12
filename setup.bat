@echo off
title Discord Bot Setup
echo ======================================
echo   Discord Bot Kurulum Baslatiliyor...
echo ======================================
echo.

:: Node.js kontrolü
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo HATA: Node.js yuklu degil. https://nodejs.org adresinden kur.
    pause
    exit /b
)

:: Paketleri kur
echo [1/2] Gerekli paketler yukleniyor...
call npm init -y
call npm install discord.js discord.js-selfbot-v13 dotenv uuid

:: .env dosyasi kontrol
if not exist ".env" (
    echo [2/2] .env dosyasi olusturuluyor...
    (
        echo CONTROL_BOT_TOKEN=BOT_TOKENIN
        echo CONTROL_ALLOWED_USER_IDS=DISCORD_IDIN
        echo DB_PATH=./db.json
    ) > .env
    echo Lutfen .env dosyasini ac ve bilgilerini doldur!
)

echo.
echo Kurulum tamamlandi ✅
pause
