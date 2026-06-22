"""
Payroll Data Cleaning Application - FastAPI Backend
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import upload, cleaning, comparison, export, jobs, reconciliation

app = FastAPI(
    title="Payroll Data Cleaning API",
    description="API for cleaning, processing, and comparing payroll data",
    version="1.0.0"
)

# CORS middleware for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(upload.router, prefix="/api/upload", tags=["Upload"])
app.include_router(cleaning.router, prefix="/api/cleaning", tags=["Data Cleaning"])
app.include_router(comparison.router, prefix="/api/comparison", tags=["Comparison"])
app.include_router(export.router, prefix="/api/export", tags=["Export"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["Jobs"])
app.include_router(reconciliation.router, prefix="/api/reconciliation", tags=["Reconciliation"])


@app.get("/")
async def root():
    return {
        "message": "Payroll Data Cleaning API",
        "version": "1.0.0",
        "docs": "/docs"
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy"}
