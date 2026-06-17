@echo off
echo Setting up Payroll Data Cleaning Application...
echo.

REM Setup Backend
echo Setting up Backend...
cd backend

echo Creating Python virtual environment...
python -m venv venv

echo Activating virtual environment...
call venv\Scripts\activate

echo Installing Python dependencies...
pip install -r requirements.txt

echo Backend setup complete!
echo.

REM Setup Frontend
echo Setting up Frontend...
cd ..\frontend

echo Installing Node.js dependencies...
call npm install

echo Frontend setup complete!
echo.

echo ==========================================
echo Setup Complete!
echo ==========================================
echo.
echo To start the application, run: start.bat
echo Or manually:
echo   Backend:  cd backend ^&^& venv\Scripts\activate ^&^& uvicorn app.main:app --reload
echo   Frontend: cd frontend ^&^& npm run dev
echo.
pause
