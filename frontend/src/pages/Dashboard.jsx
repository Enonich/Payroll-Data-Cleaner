import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileSpreadsheet, Upload, Sparkles, GitCompare, ArrowRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { listFiles } from '../services/api';
import FileCard from '../components/FileCard';

export default function Dashboard() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const data = await listFiles();
      setFiles(data.files);
    } catch (error) {
      toast.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  };

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
