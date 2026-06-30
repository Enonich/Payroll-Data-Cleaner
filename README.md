# Payroll Data Cleaning Application

A full-stack web application for cleaning, processing, and comparing payroll data. Built with FastAPI (Python) backend and React frontend.

## Features

### Data Cleaning
- **Staff ID Normalization**: Remove `.0` suffix, standardize formats
- **Currency Value Cleaning**: Handle commas, dashes, and various number formats
- **Grade/Rank Normalization**: Handle Roman numerals, spacing, and common variations
- **Branch Name Corrections**: Fix common typos

### Comparisons
- **Salary Comparison**: Compare basic salaries, take-home pay between files
- **Employee Presence**: Find employees in one file but not another
- **ID Matching**: Normalize IDs for matching (handles 166xxxx vs 116xxxx formats)

### Template Generation
- **Allowance Files**: Generate individual allowance files from payroll data
- **Deduction Files**: Generate individual deduction files from payroll data
- **Employee Import**: Generate employee import templates

### Step Matching
- **Salary Scale Matching**: Match employees to salary scale steps based on grade and salary

## Project Structure

```
payroll_app/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI application
│   │   ├── config.py            # Configuration
│   │   ├── models/
│   │   │   └── schemas.py       # Pydantic models
│   │   ├── routers/
│   │   │   ├── upload.py        # File upload endpoints
│   │   │   ├── cleaning.py      # Data cleaning endpoints
│   │   │   ├── comparison.py    # Comparison endpoints
│   │   │   └── export.py        # Export endpoints
│   │   └── services/
│   │       ├── file_service.py       # File handling
│   │       ├── cleaning_service.py   # Data cleaning functions
│   │       ├── comparison_service.py # Comparison functions
│   │       ├── template_service.py   # Template generation
│   │       └── step_matching_service.py # Step matching
│   └── requirements.txt
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── Layout.jsx
    │   │   ├── FileUploader.jsx
    │   │   ├── DataTable.jsx
    │   │   └── FileCard.jsx
    │   ├── pages/
    │   │   ├── Dashboard.jsx
    │   │   ├── Upload.jsx
    │   │   ├── Cleaning.jsx
    │   │   ├── Comparison.jsx
    │   │   └── Export.jsx
    │   ├── services/
    │   │   └── api.js
    │   ├── App.jsx
    │   ├── main.jsx
    │   └── index.css
    ├── package.json
    └── vite.config.js
```

## Quick Start

### Backend Setup

```bash
cd payroll_app/backend

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Optional local AI comparison report
# Install/start Ollama separately, then pull the configured model:
ollama pull gemma4:e2b

# Run the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at http://localhost:8000
- API Documentation: http://localhost:8000/docs
- Alternative docs: http://localhost:8000/redoc

The employee-data comparison endpoint uses `langchain-ollama` for a local AI inconsistency report when Ollama is available. Configure it with `OLLAMA_MODEL` and `OLLAMA_BASE_URL`; defaults are `gemma4:e2b` and `http://localhost:11434`.

### Frontend Setup

```bash
cd payroll_app/frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The frontend will be available at http://localhost:3000

## API Endpoints

### Upload
- `POST /api/upload/` - Upload a single file
- `POST /api/upload/multiple` - Upload multiple files
- `GET /api/upload/` - List all files
- `GET /api/upload/{file_id}` - Get file info
- `GET /api/upload/{file_id}/preview` - Preview file data
- `DELETE /api/upload/{file_id}` - Delete a file

### Cleaning
- `POST /api/cleaning/clean` - Apply comprehensive cleaning
- `POST /api/cleaning/normalize-ids` - Normalize staff IDs
- `POST /api/cleaning/clean-currency` - Clean currency columns
- `POST /api/cleaning/normalize-grades` - Normalize grades
- `POST /api/cleaning/match-steps` - Match employees to salary steps

### Comparison
- `POST /api/comparison/salary` - Compare salaries
- `POST /api/comparison/employees` - Compare employee presence
- `POST /api/comparison/generate-allowances` - Generate allowance/deduction files

### Export
- `GET /api/export/{file_id}/csv` - Download as CSV
- `GET /api/export/{file_id}/excel` - Download as Excel
- `GET /api/export/{file_id}/stats` - Get file statistics

## Supported File Formats

- CSV (with automatic encoding detection: UTF-8, Latin-1, CP1252)
- Excel (.xlsx)
- Legacy Excel (.xls)

## Technologies Used

### Backend
- **FastAPI**: Modern Python web framework
- **Pandas**: Data manipulation and analysis
- **NumPy**: Numerical computing
- **OpenPyXL**: Excel file handling
- **Uvicorn**: ASGI server

### Frontend
- **React 18**: UI framework
- **Vite**: Build tool
- **TailwindCSS**: Styling
- **React Router**: Navigation
- **TanStack Table**: Data tables
- **React Dropzone**: File uploads
- **Axios**: HTTP client
- **Lucide React**: Icons

## Development

### Running Tests
```bash
# Backend tests
cd backend
pytest

# Frontend tests
cd frontend
npm test
```

### Building for Production
```bash
# Frontend build
cd frontend
npm run build
```

## License

MIT License
