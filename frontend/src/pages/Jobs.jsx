import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Download, AlertCircle } from 'lucide-react';
import {
  listFiles,
  listTemplates,
  createJob,
  listJobs,
  getJob,
  getJobPreview,
  fixJob,
  downloadJobOutput,
} from '../services/api';

const STATUS_BADGE = {
  pending: 'badge badge-gray',
  processing: 'badge badge-blue',
  needs_review: 'badge badge-blue',
  completed: 'badge badge-green',
  failed: 'badge badge-gray',
};

export default function Jobs() {
  const [files, setFiles] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [jobs, setJobs] = useState([]);

  const [createForm, setCreateForm] = useState({ source_file_id: '', template_id: '' });
  const [creating, setCreating] = useState(false);

  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [preview, setPreview] = useState(null);

  const [correctionForm, setCorrectionForm] = useState({ row_index: '', field: '', value: '' });
  const [pendingCorrections, setPendingCorrections] = useState([]);
  const [acceptedIssueIds, setAcceptedIssueIds] = useState([]);

  const issues = useMemo(() => selectedJob?.issues || [], [selectedJob]);
  const canDownload = selectedJob?.status === 'completed';

  useEffect(() => {
    loadInitial();
  }, []);

  async function loadInitial() {
    try {
      const [fileRes, tplRes, jobRes] = await Promise.all([listFiles(), listTemplates(), listJobs()]);
      setFiles(fileRes.files || []);
      setTemplates(tplRes.templates || []);
      setJobs(jobRes.jobs || []);
    } catch {
      toast.error('Failed to load job context');
    }
  }

  async function refreshJobsAndCurrent(jobId = selectedJobId) {
    try {
      const jobRes = await listJobs();
      setJobs(jobRes.jobs || []);
      if (jobId) {
        const job = await getJob(jobId);
        setSelectedJob(job);
        const pv = await getJobPreview(jobId, 50, true);
        setPreview(pv);
      }
    } catch {
      toast.error('Failed to refresh jobs');
    }
  }

  async function handleCreateJob() {
    if (!createForm.source_file_id || !createForm.template_id) {
      toast.error('Select source file and template');
      return;
    }

    setCreating(true);
    try {
      const res = await createJob(createForm);
      toast.success(`Job created: ${res.job.status}`);
      setSelectedJobId(res.job.id);
      setSelectedJob(res.job);
      const pv = await getJobPreview(res.job.id, 50, true);
      setPreview(pv);
      setPendingCorrections([]);
      setAcceptedIssueIds([]);
      await refreshJobsAndCurrent(res.job.id);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to create job');
    } finally {
      setCreating(false);
    }
  }

  async function handleSelectJob(jobId) {
    setSelectedJobId(jobId);
    setPendingCorrections([]);
    setAcceptedIssueIds([]);
    try {
      const [job, pv] = await Promise.all([getJob(jobId), getJobPreview(jobId, 50, true)]);
      setSelectedJob(job);
      setPreview(pv);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to load job');
    }
  }

  function fillCorrectionFromIssue(issue) {
    setCorrectionForm({
      row_index: String(issue.row_index >= 0 ? issue.row_index : ''),
      field: issue.field || '',
      value: '',
    });
  }

  function stageCorrection(override) {
    const form = override || correctionForm;
    if (form.row_index === '' || !form.field.trim()) {
      toast.error('row_index and field are required');
      return;
    }

    setPendingCorrections((prev) => [
      ...prev,
      {
        row_index: Number(form.row_index),
        field: form.field.trim(),
        value: form.value,
      },
    ]);
    if (!override) {
      setCorrectionForm({ row_index: '', field: '', value: '' });
    }
  }

  function stagePreviewCellEdit(rowIndex, field, value) {
    stageCorrection({ row_index: String(rowIndex), field, value });
  }

  async function handleApplyFixes() {
    if (!selectedJobId) {
      toast.error('Select a job first');
      return;
    }

    try {
      const payload = {
        corrections: pendingCorrections,
        accepted_issue_ids: acceptedIssueIds,
      };
      const res = await fixJob(selectedJobId, payload);
      setSelectedJob(res.job);
      setPendingCorrections([]);
      setAcceptedIssueIds([]);
      const pv = await getJobPreview(selectedJobId, 50, true);
      setPreview(pv);
      await refreshJobsAndCurrent(selectedJobId);
      toast.success(`Revalidated. Status: ${res.job.status}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to apply fixes');
    }
  }

  function toggleAcceptIssue(issueId) {
    setAcceptedIssueIds((prev) => {
      if (prev.includes(issueId)) {
        return prev.filter((id) => id !== issueId);
      }
      return [...prev, issueId];
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Cleaning Jobs</h1>
        <p className="text-sm text-slate-500">Run template-based jobs, review issues, fix rows, and download output.</p>
      </div>

      <div className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Create Job</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select
            className="input"
            value={createForm.source_file_id}
            onChange={(e) => setCreateForm((prev) => ({ ...prev, source_file_id: e.target.value }))}
          >
            <option value="">Source file</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>{f.filename}</option>
            ))}
          </select>

          <select
            className="input"
            value={createForm.template_id}
            onChange={(e) => setCreateForm((prev) => ({ ...prev, template_id: e.target.value }))}
          >
            <option value="">Template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} | {t.target_system}</option>
            ))}
          </select>

          <button className="btn btn-primary" onClick={handleCreateJob} disabled={creating}>
            {creating ? 'Creating...' : 'Create + Process Job'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card p-4 xl:col-span-1">
          <h2 className="text-sm font-semibold mb-3">Jobs</h2>
          <div className="space-y-2 max-h-[32rem] overflow-y-auto">
            {jobs.map((job) => (
              <button
                key={job.id}
                className={`w-full text-left border rounded-md p-2 ${selectedJobId === job.id ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'}`}
                onClick={() => handleSelectJob(job.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium truncate mr-2">{job.source_filename}</span>
                  <span className={STATUS_BADGE[job.status] || 'badge badge-gray'}>{job.status}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">{job.id}</div>
              </button>
            ))}
            {jobs.length === 0 && <p className="text-xs text-slate-500">No jobs yet.</p>}
          </div>
        </div>

        <div className="card p-4 xl:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Review + Fix</h2>
            {selectedJob && canDownload && (
              <a className="btn btn-primary" href={downloadJobOutput(selectedJob.id)}>
                <Download className="h-4 w-4" />
                Download Output
              </a>
            )}
            {selectedJob && !canDownload && selectedJob.status !== 'failed' && (
              <span className="text-xs text-slate-500">Download available when job is completed</span>
            )}
          </div>

          {!selectedJob && <p className="text-sm text-slate-500">Select a job to review issues.</p>}

          {selectedJob && (
            <>
              <div className="text-xs text-slate-500">
                Status: <strong>{selectedJob.status}</strong> | Issues: <strong>{issues.length}</strong>
              </div>

              {selectedJob.status === 'failed' && selectedJob.error_message && (
                <div className="flex items-start gap-2 border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{selectedJob.error_message}</span>
                </div>
              )}

              <div className="max-h-48 overflow-y-auto border rounded-md">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Accept</th>
                      <th>Type</th>
                      <th>Row</th>
                      <th>Field</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((issue) => (
                      <tr
                        key={issue.id}
                        className="cursor-pointer"
                        onClick={() => fillCorrectionFromIssue(issue)}
                        title="Click to fill correction form"
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={acceptedIssueIds.includes(issue.id)}
                            onChange={() => toggleAcceptIssue(issue.id)}
                          />
                        </td>
                        <td>{issue.type}</td>
                        <td>{issue.row_index >= 0 ? issue.row_index : '—'}</td>
                        <td>{issue.field}</td>
                        <td>{issue.message}</td>
                      </tr>
                    ))}
                    {issues.length === 0 && (
                      <tr>
                        <td colSpan={5}>No validation issues.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                <input
                  className="input"
                  type="number"
                  placeholder="row_index"
                  value={correctionForm.row_index}
                  onChange={(e) => setCorrectionForm((prev) => ({ ...prev, row_index: e.target.value }))}
                />
                <input
                  className="input"
                  placeholder="field"
                  value={correctionForm.field}
                  onChange={(e) => setCorrectionForm((prev) => ({ ...prev, field: e.target.value }))}
                />
                <input
                  className="input"
                  placeholder="value"
                  value={correctionForm.value}
                  onChange={(e) => setCorrectionForm((prev) => ({ ...prev, value: e.target.value }))}
                />
                <button className="btn btn-secondary" onClick={() => stageCorrection()}>Stage Correction</button>
              </div>

              {pendingCorrections.length > 0 && (
                <div className="text-xs border rounded-md p-2 space-y-1">
                  <div className="font-medium">Pending corrections ({pendingCorrections.length})</div>
                  {pendingCorrections.map((c, idx) => (
                    <div key={idx} className="text-slate-500">
                      row {c.row_index} · {c.field} → {c.value === '' ? '(empty)' : c.value}
                    </div>
                  ))}
                </div>
              )}

              <button className="btn btn-primary" onClick={handleApplyFixes}>Apply Fixes + Revalidate</button>

              {preview && (
                <div>
                  <h3 className="text-xs font-semibold mb-1">
                    Flagged Rows Preview ({preview.preview_rows}/{preview.total_rows})
                    <span className="font-normal text-slate-500 ml-2">Edit a cell to stage a correction</span>
                  </h3>
                  <div className="max-h-56 overflow-y-auto border rounded-md">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          {preview.columns.map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.map((row, idx) => {
                          const rowIndex = row.__row_index ?? idx;
                          return (
                            <tr key={idx}>
                              <td className="text-slate-500">{rowIndex}</td>
                              {preview.columns.map((col) => (
                                <td key={`${idx}-${col}`}>
                                  <input
                                    className="input text-xs py-0.5"
                                    defaultValue={row[col] === null ? '' : String(row[col])}
                                    onBlur={(e) => {
                                      const newVal = e.target.value;
                                      const oldVal = row[col] === null ? '' : String(row[col]);
                                      if (newVal !== oldVal) {
                                        stagePreviewCellEdit(rowIndex, col, newVal);
                                      }
                                    }}
                                  />
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                        {preview.data.length === 0 && (
                          <tr>
                            <td colSpan={Math.max(1, preview.columns.length + 1)}>No flagged rows in preview.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
