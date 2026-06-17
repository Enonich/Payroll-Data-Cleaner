import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileSpreadsheet } from 'lucide-react';

export default function FileUploader({ onUpload, multiple = false, accept = null }) {
  const onDrop = useCallback((acceptedFiles) => {
    if (onUpload) {
      onUpload(acceptedFiles);
    }
  }, [onUpload]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple,
    accept: accept || {
      'text/csv': ['.csv'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    },
  });

  return (
    <div
      {...getRootProps()}
      className={`dropzone ${isDragActive ? 'active' : ''}`}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-2">
        <div className="p-2.5 bg-blue-50 rounded-lg">
          {isDragActive ? (
            <FileSpreadsheet className="h-6 w-6 text-blue-600" />
          ) : (
            <Upload className="h-6 w-6 text-blue-500" />
          )}
        </div>
        {isDragActive ? (
          <p className="text-sm text-blue-600 font-medium">Drop files here...</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              Drop {multiple ? 'files' : 'a file'} here, or <span className="text-blue-600 font-medium">browse</span>
            </p>
            <p className="text-xs text-slate-400">
              CSV, XLS, XLSX
            </p>
          </>
        )}
      </div>
    </div>
  );
}
