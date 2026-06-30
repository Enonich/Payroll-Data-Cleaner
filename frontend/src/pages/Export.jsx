import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Download, FileSpreadsheet } from 'lucide-react';
import { listFiles, getFileStats, downloadCsv, downloadExcel } from '../services/api';

export default function Export() {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadFiles();
  }, []);

  useEffect(() => {
    if (selectedFile) {
      loadStats(selectedFile);
    }
  }, [selectedFile]);

  const loadFiles = async () => {
    try {
      const data = await listFiles();
      setFiles(data.files);
    } catch (error) {
      toast.error('Failed to load files');
    }
  };

  const loadStats = async (fileId) => {
    setLoading(true);
    try {
      const data = await getFileStats(fileId);
      setStats(data);
    } catch (error) {
      toast.error('Failed to load statistics');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (format) => {
    if (!selectedFile) {
      toast.error('Please select a file');
      return;
    }
    
    const file = files.find(f => f.id === selectedFile);
    const url = format === 'csv' 
      ? downloadCsv(selectedFile, file?.filename)
      : downloadExcel(selectedFile, file?.filename);
    window.open(url, '_blank');
    toast.success(`Downloading as ${format.toUpperCase()}`);
  };

  const formatNumber = (num) => {
    if (num === null || num === undefined) return '-';
    return typeof num === 'number' ? num.toLocaleString(undefined, { maximumFractionDigits: 2 }) : num;
  };

  return (
    <div className="space-y-4">
      {/* File Selection */}
      <div className="card p-4">
        <label className="block text-xs font-medium text-slate-600 mb-1.5">
          Select file
        </label>
        <select
          value={selectedFile}
          onChange={(e) => setSelectedFile(e.target.value)}
          className="input"
        >
          <option value="">Select a file...</option>
          {files.map((file) => (
            <option key={file.id} value={file.id}>
              {file.filename} ({file.row_count.toLocaleString()} rows)
            </option>
          ))}
        </select>
      </div>

      {selectedFile && (
        <>
          {/* Download Options */}
          <div className="card p-4">
            <h2 className="text-sm font-medium text-slate-900 mb-3">Download</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                onClick={() => handleDownload('csv')}
                className="flex items-center gap-2.5 p-3 border border-slate-200 rounded-md hover:border-emerald-400 hover:bg-emerald-50/50 transition-colors group"
              >
                <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
                <div className="text-left flex-1">
                  <p className="text-sm font-medium text-slate-900">CSV</p>
                  <p className="text-xs text-slate-500">Comma-separated</p>
                </div>
                <Download className="h-4 w-4 text-slate-400 group-hover:text-emerald-600" />
              </button>
              
              <button
                onClick={() => handleDownload('xlsx')}
                className="flex items-center gap-2.5 p-3 border border-slate-200 rounded-md hover:border-blue-400 hover:bg-blue-50/50 transition-colors group"
              >
                <FileSpreadsheet className="h-5 w-5 text-blue-600" />
                <div className="text-left flex-1">
                  <p className="text-sm font-medium text-slate-900">Excel</p>
                  <p className="text-xs text-slate-500">XLSX format</p>
                </div>
                <Download className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
              </button>
            </div>
          </div>

          {/* File Statistics */}
          {stats && (
            <div className="card p-4">
              <h2 className="text-sm font-medium text-slate-900 mb-3">Statistics</h2>
              
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="p-2.5 bg-slate-50 rounded-md">
                  <p className="text-xs text-slate-500">Rows</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {stats.total_rows.toLocaleString()}
                  </p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded-md">
                  <p className="text-xs text-slate-500">Columns</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {stats.total_columns}
                  </p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded-md">
                  <p className="text-xs text-slate-500">Numeric</p>
                  <p className="text-lg font-semibold text-slate-900">
                    {stats.numeric_columns}
                  </p>
                </div>
              </div>

              {Object.keys(stats.statistics).length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-slate-600 mb-2">Column Stats</h3>
                  <div className="overflow-hidden border border-slate-200 rounded-md">
                    <table className="data-table">
                      <thead>
                        <tr className="bg-slate-50">
                          <th className="px-3 py-1.5 text-left text-xs font-medium text-slate-600 uppercase tracking-wide">Column</th>
                          <th className="px-3 py-1.5 text-right text-xs font-medium text-slate-600 uppercase tracking-wide">Count</th>
                          <th className="px-3 py-1.5 text-right text-xs font-medium text-slate-600 uppercase tracking-wide">Sum</th>
                          <th className="px-3 py-1.5 text-right text-xs font-medium text-slate-600 uppercase tracking-wide">Mean</th>
                          <th className="px-3 py-1.5 text-right text-xs font-medium text-slate-600 uppercase tracking-wide">Min</th>
                          <th className="px-3 py-1.5 text-right text-xs font-medium text-slate-600 uppercase tracking-wide">Max</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(stats.statistics).map(([col, colStats]) => (
                          <tr key={col} className="border-t border-slate-100 hover:bg-slate-50/50">
                            <td className="px-3 py-1.5 font-medium text-slate-700">{col}</td>
                            <td className="px-3 py-1.5 text-right text-slate-600">{formatNumber(colStats.count)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-600">{formatNumber(colStats.sum)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-600">{formatNumber(colStats.mean)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-600">{formatNumber(colStats.min)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-600">{formatNumber(colStats.max)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* All Files Quick Export */}
      <div className="card p-4">
        <h2 className="text-sm font-medium text-slate-900 mb-3">All Files</h2>
        
        {files.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">No files available</p>
        ) : (
          <div className="space-y-1.5">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between p-2.5 bg-slate-50 rounded-md"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileSpreadsheet className="h-4 w-4 text-slate-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{file.filename}</p>
                    <p className="text-xs text-slate-500">
                      {file.row_count.toLocaleString()} rows
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => window.open(downloadCsv(file.id, file.filename), '_blank')}
                    className="px-2 py-1 text-xs font-medium bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200"
                  >
                    CSV
                  </button>
                  <button
                    onClick={() => window.open(downloadExcel(file.id, file.filename), '_blank')}
                    className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    Excel
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
