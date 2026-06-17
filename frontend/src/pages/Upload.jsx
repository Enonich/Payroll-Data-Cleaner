import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import FileUploader from '../components/FileUploader';
import FileCard from '../components/FileCard';
import { uploadFile, listFiles, deleteFile, downloadCsv } from '../services/api';

export default function Upload() {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const data = await listFiles();
      setFiles(data.files);
    } catch (error) {
      toast.error('Failed to load files');
    }
  };

  const handleUpload = async (acceptedFiles) => {
    setUploading(true);
    
    for (const file of acceptedFiles) {
      try {
        await uploadFile(file);
        toast.success(`Uploaded ${file.name}`);
      } catch (error) {
        toast.error(`Failed to upload ${file.name}: ${error.response?.data?.detail || error.message}`);
      }
    }
    
    setUploading(false);
    loadFiles();
  };

  const handleDelete = async (fileId) => {
    if (!confirm('Are you sure you want to delete this file?')) return;
    
    try {
      await deleteFile(fileId);
      toast.success('File deleted');
      loadFiles();
    } catch (error) {
      toast.error('Failed to delete file');
    }
  };

  const handleDownload = (fileId) => {
    const file = files.find(f => f.id === fileId);
    const url = downloadCsv(fileId, file?.filename);
    window.open(url, '_blank');
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Upload Files</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Upload CSV or Excel files for processing
        </p>
      </div>

      <div className="card p-4">
        <FileUploader onUpload={handleUpload} multiple />
        {uploading && (
          <div className="mt-3 text-center text-sm text-blue-600">
            Uploading...
          </div>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-slate-900 mb-3">
          Files ({files.length})
        </h2>
        
        {files.length === 0 ? (
          <div className="text-center py-6 text-sm text-slate-500">
            No files uploaded yet
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {files.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                onDelete={handleDelete}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
