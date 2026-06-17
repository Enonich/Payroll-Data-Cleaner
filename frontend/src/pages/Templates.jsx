import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { GripVertical, Sparkles, Save, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  listFiles,
  listTemplates,
  getTemplate,
  inferTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTransformRegistry,
  getFormulaRegistry,
} from '../services/api';

function parseValueMapLines(text) {
  const map = {};
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const sep = trimmed.indexOf('=');
    if (sep === -1) return;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (key) map[key] = value;
  });
  return map;
}

function formatValueMapLines(valueMap) {
  return Object.entries(valueMap || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function defaultTransformParams(transformDef) {
  const params = {};
  (transformDef?.params || []).forEach((p) => {
    if (p.default !== undefined) params[p.name] = p.default;
  });
  return params;
}

export default function Templates() {
  const [files, setFiles] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  const [transformRegistry, setTransformRegistry] = useState([]);
  const [formulaRegistry, setFormulaRegistry] = useState([]);

  const [inferForm, setInferForm] = useState({
    file_id: '',
    name: '',
    target_system: 'HRIS',
    import_type: 'new_hire_import',
    known_target_fields: 'employee_id,first_name,last_name,full_name,gender,department,basic_salary,hire_date',
  });
  const [inferenceResult, setInferenceResult] = useState(null);
  const [suggestedTemplate, setSuggestedTemplate] = useState(null);

  const [dragIndex, setDragIndex] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedColumns, setExpandedColumns] = useState({});

  useEffect(() => {
    loadInitial();
  }, []);

  const columnList = useMemo(() => selectedTemplate?.definition?.columns || [], [selectedTemplate]);
  const definition = selectedTemplate?.definition || {};

  async function loadInitial() {
    try {
      const [fileRes, tplRes, transformRes, formulaRes] = await Promise.all([
        listFiles(),
        listTemplates(),
        getTransformRegistry(),
        getFormulaRegistry(),
      ]);
      setFiles(fileRes.files || []);
      setTemplates(tplRes.templates || []);
      setTransformRegistry(transformRes.transforms || []);
      setFormulaRegistry(formulaRes.formulas || []);
    } catch {
      toast.error('Failed to load templates context');
    }
  }

  async function loadTemplate(templateId) {
    if (!templateId) {
      setSelectedTemplateId('');
      setSelectedTemplate(null);
      setExpandedColumns({});
      return;
    }
    setSelectedTemplateId(templateId);
    try {
      const tpl = await getTemplate(templateId);
      setSelectedTemplate(tpl);
      setExpandedColumns({});
    } catch {
      toast.error('Failed to load template details');
    }
  }

  async function handleInfer() {
    if (!inferForm.file_id || !inferForm.name.trim()) {
      toast.error('Choose a source file and template name');
      return;
    }

    const knownFields = inferForm.known_target_fields
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    try {
      const res = await inferTemplate({
        file_id: inferForm.file_id,
        name: inferForm.name.trim(),
        target_system: inferForm.target_system.trim(),
        import_type: inferForm.import_type.trim(),
        known_target_fields: knownFields.length > 0 ? knownFields : undefined,
      });
      setInferenceResult(res);
      setSuggestedTemplate(res.suggested_template);
      toast.success('Template suggestion ready. Review mappings and save.');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Inference failed');
    }
  }

  async function handleCreateFromSuggestion() {
    if (!suggestedTemplate) {
      toast.error('No suggested template to save');
      return;
    }

    try {
      const payload = {
        name: suggestedTemplate.name,
        target_system: suggestedTemplate.target_system,
        import_type: suggestedTemplate.import_type,
        definition: suggestedTemplate.definition,
      };
      const created = await createTemplate(payload);
      toast.success('Template created');
      setSuggestedTemplate(null);
      setInferenceResult(null);
      await loadInitial();
      await loadTemplate(created.template.id);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to create template');
    }
  }

  function updateDefinition(patch) {
    if (!selectedTemplate) return;
    setSelectedTemplate({
      ...selectedTemplate,
      definition: { ...selectedTemplate.definition, ...patch },
    });
  }

  function updateColumn(index, patch) {
    if (!selectedTemplate) return;
    const nextColumns = [...columnList];
    nextColumns[index] = { ...nextColumns[index], ...patch };
    updateDefinition({ columns: nextColumns });
  }

  function removeColumn(index) {
    if (!selectedTemplate) return;
    const nextColumns = columnList.filter((_, i) => i !== index);
    updateDefinition({ columns: nextColumns });
  }

  async function saveTemplate() {
    if (!selectedTemplate) return;
    setSaving(true);
    try {
      const payload = {
        name: selectedTemplate.name,
        target_system: selectedTemplate.target_system,
        import_type: selectedTemplate.import_type,
        definition: selectedTemplate.definition,
      };
      const updated = await updateTemplate(selectedTemplate.id, payload);
      setSelectedTemplate(updated.template);
      await loadInitial();
      toast.success('Template saved');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTemplate() {
    if (!selectedTemplate) return;
    if (!window.confirm(`Delete template "${selectedTemplate.name}"?`)) return;
    try {
      await deleteTemplate(selectedTemplate.id);
      toast.success('Template deleted');
      setSelectedTemplate(null);
      setSelectedTemplateId('');
      await loadInitial();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to delete template');
    }
  }

  function onDragStart(index) {
    setDragIndex(index);
  }

  async function onDrop(targetIndex) {
    if (dragIndex === null || dragIndex === targetIndex || !selectedTemplate) return;
    const nextColumns = [...columnList];
    const [moved] = nextColumns.splice(dragIndex, 1);
    nextColumns.splice(targetIndex, 0, moved);
    const nextDefinition = { ...selectedTemplate.definition, columns: nextColumns };
    setSelectedTemplate({ ...selectedTemplate, definition: nextDefinition });
    setDragIndex(null);

    setSaving(true);
    try {
      const updated = await updateTemplate(selectedTemplate.id, { definition: nextDefinition });
      setSelectedTemplate(updated.template);
      toast.success('Column order updated');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to update column order');
    } finally {
      setSaving(false);
    }
  }

  function addFormulaColumn() {
    if (!selectedTemplate) return;
    const existing = new Set(columnList.map((c) => c.target_field));
    let i = 1;
    let field = `computed_field_${i}`;
    while (existing.has(field)) {
      i += 1;
      field = `computed_field_${i}`;
    }

    const formulaColumn = {
      target_field: field,
      source_aliases: [],
      required: false,
      transforms: [],
      value_map: {},
      formula: { function: 'concat_with_space', args: [], kwargs: {} },
    };

    updateDefinition({ columns: [...columnList, formulaColumn] });
  }

  function addMappedColumn() {
    if (!selectedTemplate) return;
    const existing = new Set(columnList.map((c) => c.target_field));
    let i = 1;
    let field = `new_field_${i}`;
    while (existing.has(field)) {
      i += 1;
      field = `new_field_${i}`;
    }
    updateDefinition({
      columns: [
        ...columnList,
        {
          target_field: field,
          source_aliases: [field],
          required: false,
          transforms: [],
          value_map: {},
        },
      ],
    });
  }

  function toggleTransform(index, transformName) {
    const col = columnList[index];
    const transforms = [...(col.transforms || [])];
    const existingIdx = transforms.findIndex((t) =>
      (typeof t === 'string' ? t : t.name) === transformName
    );
    if (existingIdx >= 0) {
      transforms.splice(existingIdx, 1);
    } else {
      const def = transformRegistry.find((t) => t.name === transformName);
      transforms.push({ name: transformName, params: defaultTransformParams(def) });
    }
    updateColumn(index, { transforms });
  }

  function updateTransformParam(colIndex, transformName, paramName, value) {
    const col = columnList[colIndex];
    const transforms = (col.transforms || []).map((t) => {
      const name = typeof t === 'string' ? t : t.name;
      if (name !== transformName) return t;
      const params = { ...(typeof t === 'string' ? {} : t.params || {}) };
      const def = transformRegistry.find((r) => r.name === transformName);
      const paramDef = def?.params?.find((p) => p.name === paramName);
      if (paramDef?.type === 'number') {
        params[paramName] = value === '' ? '' : Number(value);
      } else {
        params[paramName] = value;
      }
      return { name: transformName, params };
    });
    updateColumn(colIndex, { transforms });
  }

  function toggleColumnExpanded(index) {
    setExpandedColumns((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  const formulaFunctions = formulaRegistry.length
    ? formulaRegistry.map((f) => f.name)
    : ['concat', 'concat_with_space', 'age_years', 'tenure_years', 'upper', 'lower', 'title_case'];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Import Templates</h1>
        <p className="text-sm text-slate-500">
          Create templates by inference, configure mappings and cleaning rules, and reorder output columns.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card p-4 space-y-3">
          <h2 className="text-sm font-semibold">Template Inference</h2>
          <select
            className="input"
            value={inferForm.file_id}
            onChange={(e) => setInferForm((prev) => ({ ...prev, file_id: e.target.value }))}
          >
            <option value="">Source file</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>{f.filename}</option>
            ))}
          </select>
          <input
            className="input"
            value={inferForm.name}
            onChange={(e) => setInferForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Template name"
          />
          <input
            className="input"
            value={inferForm.target_system}
            onChange={(e) => setInferForm((prev) => ({ ...prev, target_system: e.target.value }))}
            placeholder="Target system"
          />
          <input
            className="input"
            value={inferForm.import_type}
            onChange={(e) => setInferForm((prev) => ({ ...prev, import_type: e.target.value }))}
            placeholder="Import type (e.g. new_hire_import)"
          />
          <textarea
            className="input min-h-[100px]"
            value={inferForm.known_target_fields}
            onChange={(e) => setInferForm((prev) => ({ ...prev, known_target_fields: e.target.value }))}
            placeholder="Known target fields (comma separated)"
          />
          <button className="btn btn-primary w-full" onClick={handleInfer}>
            <Sparkles className="h-4 w-4" />
            Suggest Mapping
          </button>

          {suggestedTemplate && (
            <button className="btn btn-secondary w-full" onClick={handleCreateFromSuggestion}>
              Save Suggested Template
            </button>
          )}

          {inferenceResult && (
            <div className="border rounded-md p-2 space-y-2 text-xs">
              <div className="font-medium">Detected columns ({inferenceResult.detected_columns.length})</div>
              <div className="text-slate-500 break-words">
                {inferenceResult.detected_columns.join(', ')}
              </div>
              {inferenceResult.sample_rows?.length > 0 && (
                <div className="max-h-32 overflow-auto border rounded">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {inferenceResult.detected_columns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {inferenceResult.sample_rows.slice(0, 5).map((row, idx) => (
                        <tr key={idx}>
                          {inferenceResult.detected_columns.map((col) => (
                            <td key={`${idx}-${col}`}>{row[col] == null ? '' : String(row[col])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card p-4 xl:col-span-2 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-semibold">Template Builder</h2>
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-secondary" onClick={addMappedColumn} disabled={!selectedTemplate}>
                Add Mapped Column
              </button>
              <button className="btn btn-secondary" onClick={addFormulaColumn} disabled={!selectedTemplate}>
                Add Formula Column
              </button>
              <button className="btn btn-primary" onClick={saveTemplate} disabled={!selectedTemplate || saving}>
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save Template'}
              </button>
              <button className="btn btn-secondary" onClick={handleDeleteTemplate} disabled={!selectedTemplate}>
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            </div>
          </div>

          <select
            className="input"
            value={selectedTemplateId}
            onChange={(e) => loadTemplate(e.target.value)}
          >
            <option value="">Select template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} | {t.target_system} | {t.import_type} | updated {t.updated_at?.slice(0, 10)}
              </option>
            ))}
          </select>

          {!selectedTemplate && (
            <p className="text-sm text-slate-500">
              Select a template to edit mappings, transforms, value maps, and column order.
            </p>
          )}

          {selectedTemplate && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 border rounded-lg p-3 bg-slate-50">
                <input
                  className="input"
                  value={selectedTemplate.name}
                  onChange={(e) => setSelectedTemplate({ ...selectedTemplate, name: e.target.value })}
                  placeholder="Template name"
                />
                <input
                  className="input"
                  value={selectedTemplate.target_system}
                  onChange={(e) => setSelectedTemplate({ ...selectedTemplate, target_system: e.target.value })}
                  placeholder="Target system"
                />
                <input
                  className="input"
                  value={selectedTemplate.import_type}
                  onChange={(e) => setSelectedTemplate({ ...selectedTemplate, import_type: e.target.value })}
                  placeholder="Import type"
                />
                <select
                  className="input"
                  value={definition.output_format || 'csv'}
                  onChange={(e) => updateDefinition({ output_format: e.target.value })}
                >
                  <option value="csv">Output: CSV</option>
                  <option value="xlsx">Output: Excel (.xlsx)</option>
                </select>
                <input
                  className="input md:col-span-2"
                  value={(definition.required_fields || []).join(', ')}
                  onChange={(e) =>
                    updateDefinition({
                      required_fields: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                    })
                  }
                  placeholder="Required fields (comma separated)"
                />
                <input
                  className="input md:col-span-2"
                  value={(definition.dedup_keys || []).join(', ')}
                  onChange={(e) =>
                    updateDefinition({
                      dedup_keys: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                    })
                  }
                  placeholder="Dedup keys (comma separated, e.g. employee_id)"
                />
              </div>

              <div className="space-y-2">
                {columnList.map((col, index) => {
                  const isExpanded = expandedColumns[index];
                  const activeTransforms = (col.transforms || []).map((t) =>
                    typeof t === 'string' ? t : t.name
                  );
                  const formulaMeta = formulaRegistry.find((f) => f.name === col.formula?.function);

                  return (
                    <div
                      key={`${col.target_field}-${index}`}
                      className="border rounded-lg p-3 bg-white"
                      draggable
                      onDragStart={() => onDragStart(index)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(index)}
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-slate-400 shrink-0" />
                        <button
                          type="button"
                          className="text-slate-400"
                          onClick={() => toggleColumnExpanded(index)}
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                        <input
                          className="input flex-1"
                          value={col.target_field}
                          onChange={(e) => updateColumn(index, { target_field: e.target.value })}
                        />
                        {col.formula && <span className="badge badge-blue">fx</span>}
                        {col.required && <span className="badge badge-gray">required</span>}
                        <button
                          type="button"
                          className="btn btn-secondary text-xs"
                          onClick={() => removeColumn(index)}
                        >
                          Remove
                        </button>
                      </div>

                      {isExpanded && !col.formula && (
                        <div className="mt-3 space-y-2 pl-6">
                          <div>
                            <label className="text-xs text-slate-500">Source aliases (comma separated)</label>
                            <input
                              className="input"
                              value={(col.source_aliases || []).join(', ')}
                              onChange={(e) =>
                                updateColumn(index, {
                                  source_aliases: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                                })
                              }
                            />
                          </div>
                          <div className="flex gap-4 text-xs">
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={!!col.required}
                                onChange={(e) => updateColumn(index, { required: e.target.checked })}
                              />
                              Required
                            </label>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={!!col.strict_value_map}
                                onChange={(e) => updateColumn(index, { strict_value_map: e.target.checked })}
                              />
                              Strict value map
                            </label>
                          </div>
                          <div>
                            <label className="text-xs text-slate-500">Value map (source=value per line)</label>
                            <textarea
                              className="input min-h-[72px] font-mono text-xs"
                              value={formatValueMapLines(col.value_map)}
                              onChange={(e) => updateColumn(index, { value_map: parseValueMapLines(e.target.value) })}
                              placeholder={'M=Male\nF=Female'}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-slate-500">Cleaning transforms</label>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {transformRegistry.map((t) => (
                                <button
                                  key={t.name}
                                  type="button"
                                  className={`badge ${activeTransforms.includes(t.name) ? 'badge-blue' : 'badge-gray'}`}
                                  onClick={() => toggleTransform(index, t.name)}
                                >
                                  {t.label || t.name}
                                </button>
                              ))}
                            </div>
                            {activeTransforms.map((name) => {
                              const def = transformRegistry.find((t) => t.name === name);
                              const transform = (col.transforms || []).find((t) =>
                                (typeof t === 'string' ? t : t.name) === name
                              );
                              const params = typeof transform === 'string' ? {} : transform?.params || {};
                              if (!def?.params?.length) return null;
                              return (
                                <div key={name} className="mt-2 grid grid-cols-2 gap-2">
                                  {def.params.map((p) => (
                                    <div key={p.name}>
                                      <label className="text-[11px] text-slate-500">{p.name}</label>
                                      <input
                                        className="input"
                                        value={params[p.name] ?? ''}
                                        onChange={(e) => updateTransformParam(index, name, p.name, e.target.value)}
                                      />
                                    </div>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {isExpanded && col.formula && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3 pl-6">
                          <div>
                            <label className="text-xs text-slate-500">Function</label>
                            <select
                              className="input"
                              value={col.formula.function}
                              onChange={(e) =>
                                updateColumn(index, {
                                  formula: { ...col.formula, function: e.target.value },
                                })
                              }
                            >
                              {formulaFunctions.map((fn) => (
                                <option key={fn} value={fn}>{fn}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-slate-500">
                              Args {formulaMeta?.args_hint ? `(${formulaMeta.args_hint})` : ''}
                            </label>
                            <input
                              className="input"
                              value={(col.formula.args || []).join(',')}
                              onChange={(e) =>
                                updateColumn(index, {
                                  formula: {
                                    ...col.formula,
                                    args: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                                  },
                                })
                              }
                              placeholder="Use $field refs"
                            />
                          </div>
                          {(formulaMeta?.kwargs || []).includes('separator') && (
                            <div>
                              <label className="text-xs text-slate-500">Separator (kwargs)</label>
                              <input
                                className="input"
                                value={col.formula.kwargs?.separator ?? ''}
                                onChange={(e) =>
                                  updateColumn(index, {
                                    formula: {
                                      ...col.formula,
                                      kwargs: { ...(col.formula.kwargs || {}), separator: e.target.value },
                                    },
                                  })
                                }
                              />
                            </div>
                          )}
                          <div className="flex items-end">
                            <label className="flex items-center gap-1 text-xs">
                              <input
                                type="checkbox"
                                checked={!!col.required}
                                onChange={(e) => updateColumn(index, { required: e.target.checked })}
                              />
                              Required
                            </label>
                          </div>
                        </div>
                      )}

                      {!isExpanded && !col.formula && (
                        <div className="text-xs text-slate-500 mt-1 pl-6">
                          Aliases: {(col.source_aliases || []).join(', ') || 'None'}
                          {activeTransforms.length > 0 && ` | Transforms: ${activeTransforms.join(', ')}`}
                          {Object.keys(col.value_map || {}).length > 0 && ` | ${Object.keys(col.value_map).length} value maps`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
