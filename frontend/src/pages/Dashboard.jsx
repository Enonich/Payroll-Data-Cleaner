import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileSpreadsheet, Upload, Sparkles, GitCompare, ArrowRight, BarChart3, FileDown } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  listFiles,
  getDashboardSummary,
  getReconciliationReport,
  exportReconciliationReport,
  downloadCsv,
} from '../services/api';
import FileCard from '../components/FileCard';

export default function Dashboard() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [latestReport, setLatestReport] = useState(null);
  const [reportExport, setReportExport] = useState(null);
  const [exportingReport, setExportingReport] = useState(false);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const [fileData, dashboardData] = await Promise.all([
        listFiles(),
        getDashboardSummary(),
      ]);

      setFiles(fileData.files || []);
      setSummary(dashboardData);

      if (dashboardData?.latest_run?.id) {
        try {
          const reportData = await getReconciliationReport(dashboardData.latest_run.id);
          setLatestReport(reportData);
        } catch {
          setLatestReport(null);
        }
      } else {
        setLatestReport(null);
      }
    } catch (error) {
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const handleExportLatestReport = async () => {
    const runId = summary?.latest_run?.id;
    if (!runId) {
      toast.error('No reconciliation run available yet');
      return;
    }

    setExportingReport(true);
    try {
      const data = await exportReconciliationReport(runId);
      setReportExport(data);
      toast.success(`Generated ${Object.keys(data.files || {}).length} report file(s)`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to export report');
    } finally {
      setExportingReport(false);
    }
  };

  const metricCards = [
    {
      key: 'total_records',
      label: 'Total Records',
      value: summary?.metrics?.total_records || 0,
      tone: 'bg-slate-50 border-slate-200 text-slate-900',
    },
    {
      key: 'matched_employees',
      label: 'Matched Employees',
      value: summary?.metrics?.matched_employees || 0,
      tone: 'bg-blue-50 border-blue-200 text-blue-900',
    },
    {
      key: 'new_employees',
      label: 'New Employees',
      value: summary?.metrics?.new_employees || 0,
      tone: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    },
    {
      key: 'potential_resignations',
      label: 'Potential Resignations',
      value: summary?.metrics?.potential_resignations || 0,
      tone: 'bg-amber-50 border-amber-200 text-amber-900',
    },
    {
      key: 'missing_ids',
      label: 'Missing IDs',
      value: summary?.metrics?.missing_ids || 0,
      tone: 'bg-rose-50 border-rose-200 text-rose-900',
    },
    {
      key: 'salary_changes',
      label: 'Salary Changes',
      value: summary?.metrics?.salary_changes || 0,
      tone: 'bg-cyan-50 border-cyan-200 text-cyan-900',
    },
    {
      key: 'rank_changes',
      label: 'Rank Changes',
      value: summary?.metrics?.rank_changes || 0,
      tone: 'bg-indigo-50 border-indigo-200 text-indigo-900',
    },
    {
      key: 'manual_reviews_needed',
      label: 'Manual Reviews Needed',
      value: summary?.metrics?.manual_reviews_needed || 0,
      tone: 'bg-fuchsia-50 border-fuchsia-200 text-fuchsia-900',
    },
  ];

  const quickActions = [
    {
      title: 'Upload Files',
      description: 'Upload CSV or Excel files',
      icon: Upload,
      path: '/upload',
      color: 'blue',
    },
    {
      title: 'Clean Data',
      description: 'Normalize IDs, currencies, grades',
      icon: Sparkles,
      path: '/cleaning',
      color: 'purple',
    },
    {
      title: 'Compare Files',
      description: 'Find differences between files',
      icon: GitCompare,
      path: '/comparison',
      color: 'green',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Payroll Data Cleaning Application
        </p>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {quickActions.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.path}
              to={action.path}
              className="card p-4 hover:shadow-md transition-all group"
            >
              <div className={`p-2 rounded-md bg-${action.color}-50 w-fit`}>
                <Icon className={`h-4 w-4 text-${action.color}-600`} />
              </div>
              <h3 className="mt-2.5 text-sm font-medium text-slate-900 flex items-center gap-1">
                {action.title}
                <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">{action.description}</p>
            </Link>
          );
        })}
      </div>

      {/* Reconciliation Summary */}
      <div className="card p-4 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-medium text-slate-900 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-blue-600" />
              Payroll Reconciliation Snapshot
            </h2>
            {summary?.latest_run ? (
              <p className="text-xs text-slate-500 mt-1">
                Latest run: {summary.latest_run.file2_label} vs {summary.latest_run.file1_label}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                No reconciliation run yet. Run a Payroll Audit from the Compare page.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/comparison" className="btn btn-secondary text-xs">Open Review Workbench</Link>
            <button
              onClick={handleExportLatestReport}
              disabled={exportingReport || !summary?.latest_run?.id}
              className="btn btn-primary text-xs disabled:opacity-50"
            >
              <FileDown className="h-3.5 w-3.5" />
              {exportingReport ? 'Exporting...' : 'Export Latest Report'}
            </button>
          </div>
        </div>

        {summary?.has_data ? (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
            {metricCards.map((card) => (
              <div key={card.key} className={`border rounded-lg px-3 py-2 ${card.tone}`}>
                <div className="text-[11px] uppercase tracking-[0.08em] opacity-75">{card.label}</div>
                <div className="text-xl font-semibold mt-1">{Number(card.value || 0).toLocaleString()}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            Dashboard metrics will appear after you run your first Payroll Audit in Compare.
          </div>
        )}

        {latestReport?.high_impact_issues?.length > 0 && (
          <div className="rounded-lg border border-slate-200">
            <div className="px-3 py-2 border-b border-slate-200 bg-slate-50">
              <h3 className="text-xs font-medium text-slate-700">High Impact Differences</h3>
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Issue Type</th>
                    <th>Employee</th>
                    <th>Field</th>
                    <th>Difference</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {latestReport.high_impact_issues.slice(0, 10).map((issue) => (
                    <tr key={issue.issue_id}>
                      <td>{String(issue.issue_type || '').replaceAll('_', ' ')}</td>
                      <td>
                        <div className="text-xs font-medium text-slate-800">{issue.employee_id || '-'}</div>
                        {issue.employee_name && <div className="text-[11px] text-slate-500">{issue.employee_name}</div>}
                      </td>
                      <td>{issue.field || '-'}</td>
                      <td>{issue.difference === null || issue.difference === undefined ? '-' : Number(issue.difference).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td>{issue.status || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {reportExport?.files && Object.keys(reportExport.files).length > 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="text-xs font-medium text-emerald-900 mb-2">Generated Report Files</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(reportExport.files).map(([name, meta]) => (
                <button
                  key={name}
                  onClick={() => window.open(downloadCsv(meta.file_id), '_blank')}
                  className="btn btn-secondary text-xs"
                >
                  {name} ({Number(meta.records || 0).toLocaleString()})
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recent Files */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-slate-900">Recent Files</h2>
          {files.length > 0 && (
            <Link
              to="/upload"
              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              View all →
            </Link>
          )}
        </div>

        {loading ? (
          <div className="text-center py-6 text-sm text-slate-500">Loading...</div>
        ) : files.length === 0 ? (
          <div className="card p-6 text-center">
            <FileSpreadsheet className="h-8 w-8 text-slate-300 mx-auto" />
            <p className="mt-2 text-sm text-slate-500">No files uploaded yet</p>
            <Link
              to="/upload"
              className="mt-3 btn btn-primary inline-flex"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload file
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {files.slice(0, 6).map((file) => (
              <FileCard key={file.id} file={file} />
            ))}
          </div>
        )}
      </div>

      {/* Features Overview */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4">
        <h2 className="text-sm font-medium text-slate-900 mb-3">
          Features
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-medium text-slate-700">Data Cleaning</h3>
            <ul className="text-xs text-slate-600 mt-1 space-y-0.5">
              <li>• Normalize staff IDs</li>
              <li>• Clean currency values</li>
              <li>• Fix grade/rank names</li>
              <li>• Fix branch name typos</li>
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-medium text-slate-700">Comparisons</h3>
            <ul className="text-xs text-slate-600 mt-1 space-y-0.5">
              <li>• Compare payroll periods</li>
              <li>• Find missing employees</li>
              <li>• Match salary steps</li>
              <li>• Generate allowance files</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
