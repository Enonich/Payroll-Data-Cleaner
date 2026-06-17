import { FileSpreadsheet, Trash2, Eye, Download } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function FileCard({ file, onDelete, onDownload }) {
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div className="card p-3 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 bg-blue-50 rounded">
            <FileSpreadsheet className="h-4 w-4 text-blue-600" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-slate-900 text-sm truncate" title={file.filename}>
              {file.filename}
            </h3>
            <p className="text-xs text-slate-500">
              {formatSize(file.size)} · {file.row_count.toLocaleString()} rows
            </p>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Link
            to={`/cleaning/${file.id}`}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
            title="View & Clean"
          >
            <Eye className="h-3.5 w-3.5" />
          </Link>
          {onDownload && (
            <button
              onClick={() => onDownload(file.id)}
              className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(file.id)}
              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {file.columns.slice(0, 4).map((col) => (
          <span
            key={col}
            className="badge badge-gray"
          >
            {col}
          </span>
        ))}
        {file.columns.length > 4 && (
          <span className="badge badge-gray">
            +{file.columns.length - 4}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {formatDate(file.uploaded_at)}
      </p>
    </div>
  );
}
