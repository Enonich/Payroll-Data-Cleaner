@echo off
echo Starting Payroll Data Cleaning Application...
echo.

REM Start Backend
echo Starting Backend Server...
cd backend
start cmd /k "venv\Scripts\activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

REM Wait a moment for backend to start
timeout /t 3 /nobreak > nul

REM Start Frontend
echo Starting Frontend Server...
cd ..\frontend
start cmd /k "npm run dev"

echo.
echo Application started!
echo Backend: http://localhost:8000
echo Frontend: http://localhost:3000
echo API Docs: http://localhost:8000/docs
echo.
pause
