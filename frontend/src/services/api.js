import axios from 'axios';

const API_BASE_URL = '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Upload endpoints
export const uploadFile = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await api.post('/upload/', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
};

export const uploadMultipleFiles = async (files) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  const response = await api.post('/upload/multiple', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
};

export const listFiles = async () => {
  const response = await api.get('/upload/');
  return response.data;
};

export const getFileInfo = async (fileId) => {
  const response = await api.get(`/upload/${fileId}`);
  return response.data;
};

export const getFilePreview = async (fileId, rows = 100) => {
  const response = await api.get(`/upload/${fileId}/preview?rows=${rows}`);
  return response.data;
};

export const getFileData = async (fileId, offset = 0, limit = 0) => {
  const response = await api.get(`/upload/${fileId}/data?offset=${offset}&limit=${limit}`);
  return response.data;
};

export const getFileColumns = async (fileId) => {
  const response = await api.get(`/upload/${fileId}/columns`);
  return response.data;
};

export const deleteFile = async (fileId) => {
  const response = await api.delete(`/upload/${fileId}`);
  return response.data;
};

// Cleaning endpoints
export const cleanData = async (options) => {
  const response = await api.post('/cleaning/clean', options);
  return response.data;
};

export const normalizeStaffIds = async (fileId, idColumn) => {
  const response = await api.post('/cleaning/normalize-ids', {
    file_id: fileId,
    id_column: idColumn,
  });
  return response.data;
};

export const cleanCurrencyColumns = async (fileId, columns) => {
  const response = await api.post('/cleaning/clean-currency', {
    file_id: fileId,
    columns: columns,
  });
  return response.data;
};

export const normalizeGrades = async (fileId, gradeColumn) => {
  const response = await api.post('/cleaning/normalize-grades', {
    file_id: fileId,
    grade_column: gradeColumn,
  });
  return response.data;
};

export const applyColumnOperations = async (fileId, operations, stripColumnNames = false) => {
  const response = await api.post('/cleaning/apply-operations', {
    file_id: fileId,
    operations,
    strip_column_names: stripColumnNames,
  });
  return response.data;
};

export const getColumnValues = async (fileId, column) => {
  const response = await api.get(
    `/cleaning/${fileId}/column-values/${encodeURIComponent(column)}`
  );
  return response.data;
};

export const matchSteps = async (options) => {
  const response = await api.post('/cleaning/match-steps', options);
  return response.data;
};

export const detectColumnTypes = async (fileId) => {
  const response = await api.get(`/cleaning/${fileId}/detect-types`);
  return response.data;
};

export const enrichIdsByName = async (options) => {
  const response = await api.post('/cleaning/enrich-ids-by-name', options);
  return response.data;
};

export const updateRows = async (fileId, updates) => {
  const response = await api.post('/cleaning/update-rows', {
    file_id: fileId,
    updates,
  });
  return response.data;
};

export const reorderColumns = async (fileId, columnOrder) => {
  const response = await api.post('/cleaning/reorder-columns', {
    file_id: fileId,
    column_order: columnOrder,
  });
  return response.data;
};

export const deleteColumn = async (fileId, columnName) => {
  const response = await api.post('/cleaning/delete-column', {
    file_id: fileId,
    column_name: columnName,
  });
  return response.data;
};

export const addFormulaColumn = async (options) => {
  const response = await api.post('/cleaning/add-formula-column', options);
  return response.data;
};

// Comparison endpoints
export const compareSalaries = async (options) => {
  const response = await api.post('/comparison/salary', options);
  return response.data;
};

export const compareEmployeePresence = async (options) => {
  const response = await api.post('/comparison/employees', options);
  return response.data;
};

export const compareEmployeeData = async (options) => {
  const response = await api.post('/comparison/employee-data', options);
  return response.data;
};

export const generateAllowanceFiles = async (options) => {
  const response = await api.post('/comparison/generate-allowances', options);
  return response.data;
};

export const identifyColumns = async (fileId) => {
  const response = await api.get(`/comparison/${fileId}/identify-columns`);
  return response.data;
};

// Export endpoints
export const downloadCsv = (fileId, filename) => {
  const params = filename ? `?filename=${filename}` : '';
  return `${API_BASE_URL}/export/${fileId}/csv${params}`;
};

export const downloadExcel = (fileId, filename) => {
  const params = filename ? `?filename=${filename}` : '';
  return `${API_BASE_URL}/export/${fileId}/excel${params}`;
};

export const getFileStats = async (fileId) => {
  const response = await api.get(`/export/${fileId}/stats`);
  return response.data;
};

// Job lifecycle endpoints
export const createJob = async (payload) => {
  const response = await api.post('/jobs/', payload);
  return response.data;
};

export const listJobs = async () => {
  const response = await api.get('/jobs/');
  return response.data;
};

export const getJob = async (jobId) => {
  const response = await api.get(`/jobs/${jobId}`);
  return response.data;
};

export const getJobPreview = async (jobId, rows = 100, onlyFlagged = false) => {
  const response = await api.get(`/jobs/${jobId}/preview?rows=${rows}&only_flagged=${onlyFlagged}`);
  return response.data;
};

export const fixJob = async (jobId, payload) => {
  const response = await api.post(`/jobs/${jobId}/fix`, payload);
  return response.data;
};

export const downloadJobOutput = (jobId) => `${API_BASE_URL}/jobs/${jobId}/download`;

export default api;
