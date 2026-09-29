import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import PageHero from "../components/PageHero";
import StudentForm from "../components/StudentForm";
import ConfirmationModal from "../components/ConfirmationModal";
import Pager from "../components/admin/Pager";
import InlineAlert from "../components/admin/InlineAlert";
import { IconSearch, IconDownload, IconPlus, IconRefreshCw } from "../components/Icons";
import {
  getStudents,
  registerStudent,
  deleteStudent,
  restoreStudent,
  bulkImportStudents,
  exportStudents,
  getStudentFeeHistory,
  resetStudentPayment,
  reconcileStudent,
  setReminderOptOut,
} from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import { usePermissions } from "../hooks/usePermissions";

const PAGE_SIZE = 20;

function apiError(err, fallback) {
  const data = err?.response?.data;
  return getErrorMessage(data?.code, data?.error) || fallback;
}

function studentStatus(s) {
  if (s.feePaid) return "paid";
  return (s.totalPaid || 0) > 0 ? "partial" : "unpaid";
}

const STATUS_BADGE = { paid: "badge-success", partial: "badge-warning", unpaid: "badge-danger" };

// ── Create student ────────────────────────────────────────────────────────────

function CreateStudentForm({ onCreated, onCancel }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ studentId: "", name: "", class: "", feeAmount: "", parentEmail: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), class: form.class.trim() };
      if (form.studentId.trim()) payload.studentId = form.studentId.trim();
      if (form.feeAmount !== "") payload.feeAmount = Number(form.feeAmount);
      if (form.parentEmail.trim()) payload.parentEmail = form.parentEmail.trim();
      await registerStudent(payload);
      onCreated();
    } catch (err) {
      setError(apiError(err, t("students.createFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card admin-section" onSubmit={handleSubmit} aria-label={t("students.createTitle")}>
      <div className="card-header"><h2 className="card-title">{t("students.createTitle")}</h2></div>
      <div className="card-body">
        <InlineAlert>{error}</InlineAlert>
        <div className="admin-grid-2">
          <div className="form-group">
            <label className="form-label" htmlFor="new-student-id">{t("students.fieldStudentId")}</label>
            <input id="new-student-id" className="form-input" value={form.studentId} onChange={set("studentId")} placeholder={t("students.studentIdHint")} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-student-name">{t("students.fieldName")}</label>
            <input id="new-student-name" className="form-input" required value={form.name} onChange={set("name")} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-student-class">{t("students.fieldClass")}</label>
            <input id="new-student-class" className="form-input" required value={form.class} onChange={set("class")} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-student-fee">{t("students.fieldFee")}</label>
            <input id="new-student-fee" className="form-input" type="number" min="0" step="any" value={form.feeAmount} onChange={set("feeAmount")} placeholder={t("students.feeHint")} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-student-email">{t("students.fieldParentEmail")}</label>
            <input id="new-student-email" className="form-input" type="email" value={form.parentEmail} onChange={set("parentEmail")} />
          </div>
        </div>
        <div className="admin-row-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t("actions.cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t("actions.saving") : t("students.createBtn")}
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Bulk CSV import ───────────────────────────────────────────────────────────

function BulkImportPanel({ onImported, onCancel }) {
  const { t } = useTranslation();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError(t("students.importNoFile"));
      return;
    }
    setError(null);
    setResult(null);
    setUploading(true);
    try {
      const { data } = await bulkImportStudents(file);
      setResult(data);
      onImported();
    } catch (err) {
      // A 400 with a results body means every row failed — still show details.
      if (err?.response?.data?.details) setResult(err.response.data);
      else setError(apiError(err, t("students.importFailed")));
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="card admin-section" onSubmit={handleSubmit} aria-label={t("students.importTitle")}>
      <div className="card-header"><h2 className="card-title">{t("students.importTitle")}</h2></div>
      <div className="card-body">
        <p className="text-muted">{t("students.importHelp")}</p>
        <InlineAlert>{error}</InlineAlert>
        <div className="form-group">
          <label className="form-label" htmlFor="bulk-import-file">{t("students.importFileLabel")}</label>
          <input id="bulk-import-file" ref={fileRef} type="file" accept=".csv,text/csv" className="form-input" />
        </div>
        {result && (
          <div role="status" data-testid="bulk-import-result">
            <p>{t("students.importSummary", { created: result.created, failed: result.failed, total: result.total })}</p>
            {result.details?.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("students.importRow")}</th>
                      <th scope="col">{t("students.colStudentId")}</th>
                      <th scope="col">{t("students.importError")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.details.map((d, i) => (
                      <tr key={`${d.row}-${i}`}>
                        <td>{d.row}</td>
                        <td className="mono">{d.studentId || "—"}</td>
                        <td>{d.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="admin-row-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t("actions.cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={uploading}>
            {uploading ? t("students.importing") : t("students.importBtn")}
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Restore a soft-deleted student ────────────────────────────────────────────

function RestoreStudentForm({ onRestored }) {
  const { t } = useTranslation();
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!studentId.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await restoreStudent(studentId.trim());
      setMessage(t("students.restored", { studentId: studentId.trim() }));
      setStudentId("");
      onRestored();
    } catch (err) {
      setError(apiError(err, t("students.restoreFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card admin-section" onSubmit={handleSubmit} aria-label={t("students.restoreTitle")}>
      <div className="card-header"><h2 className="card-title">{t("students.restoreTitle")}</h2></div>
      <div className="card-body">
        <p className="text-muted">{t("students.restoreHelp")}</p>
        <InlineAlert>{error}</InlineAlert>
        <InlineAlert tone="success">{message}</InlineAlert>
        <div className="admin-toolbar" style={{ padding: 0, border: 0 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="restore-student-id">{t("students.fieldStudentId")}</label>
            <input id="restore-student-id" className="form-input" value={studentId} onChange={(e) => setStudentId(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={busy || !studentId.trim()}>
            {t("students.restoreBtn")}
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Per-student detail: fee history, reconcile, reset, reminders ─────────────

function StudentDetail({ student, canWrite, canManageReminders, onChanged }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPages, setHistoryPages] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [deletePayments, setDeletePayments] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    getStudentFeeHistory(student.studentId, { page: historyPage, limit: 10 })
      .then(({ data }) => {
        if (cancelled) return;
        setHistory(data.history || []);
        setHistoryPages(data.pagination?.totalPages || 1);
        setHistoryTotal(data.pagination?.total || 0);
      })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [student.studentId, historyPage]);

  async function run(action, successMessage) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data } = await action();
      setNotice(typeof successMessage === "function" ? successMessage(data) : successMessage);
      onChanged();
    } catch (err) {
      setError(apiError(err, t("students.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  const handleReconcile = () =>
    run(() => reconcileStudent(student.studentId), (data) =>
      data.reconciled
        ? t("students.reconciledChanged", { stored: data.storedTotal, computed: data.computedTotal })
        : t("students.reconciledOk"));

  const handleReset = async () => {
    setConfirmReset(false);
    await run(() => resetStudentPayment(student.studentId, { deletePayments }), t("students.resetDone"));
  };

  const handleOptOut = (optOut) =>
    run(() => setReminderOptOut(student.studentId, optOut),
      optOut ? t("students.optedOut") : t("students.optedIn"));

  return (
    <div className="admin-detail" data-testid={`student-detail-${student.studentId}`}>
      <InlineAlert>{error}</InlineAlert>
      <InlineAlert tone="success">{notice}</InlineAlert>

      <div className="admin-row-actions" style={{ justifyContent: "flex-start", marginBottom: "1rem" }}>
        {canWrite && (
          <>
            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={handleReconcile}>
              {t("students.reconcileBtn")}
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmReset(true)}>
              {t("students.resetBtn")}
            </button>
          </>
        )}
        {canManageReminders && (
          student.reminderOptOut ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => handleOptOut(false)}>
              {t("students.optInBtn")}
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => handleOptOut(true)}>
              {t("students.optOutBtn")}
            </button>
          )
        )}
      </div>

      <h3 className="card-subtitle">{t("students.feeHistoryTitle")}</h3>
      {historyLoading ? (
        <p className="text-muted">{t("actions.loading")}</p>
      ) : history.length === 0 ? (
        <p className="text-muted">{t("students.feeHistoryEmpty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" aria-label={t("students.feeHistoryTitle")}>
            <thead>
              <tr>
                <th scope="col">{t("students.historyCategory")}</th>
                <th scope="col">{t("students.historyAmount")}</th>
                <th scope="col">{t("students.historyPaid")}</th>
                <th scope="col">{t("students.historyArchived")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={h._id || i}>
                  <td>{h.category}</td>
                  <td>{h.amount}</td>
                  <td>{h.totalPaid ?? 0}</td>
                  <td>{h.archivedAt ? new Date(h.archivedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={historyPage} pages={historyPages} total={historyTotal} loading={historyLoading} onChange={setHistoryPage} />

      {confirmReset && (
        <ConfirmationModal
          title={t("students.resetConfirmTitle")}
          description={t("students.resetConfirmDesc", { studentId: student.studentId })}
          confirmLabel={t("students.resetBtn")}
          onConfirm={handleReset}
          onCancel={() => setConfirmReset(false)}
        >
          <label className="form-check" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input type="checkbox" checked={deletePayments} onChange={(e) => setDeletePayments(e.target.checked)} />
            {t("students.resetDeletePayments")}
          </label>
        </ConfirmationModal>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  const { t } = useTranslation();
  const can = usePermissions();
  const canWrite = can("students.write");
  const canManageReminders = can("reminders.manage");

  const [students, setStudents] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [className, setClassName] = useState("");
  const [panel, setPanel] = useState(null); // 'create' | 'import' | null
  const [expanded, setExpanded] = useState(null);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      getStudents(page, PAGE_SIZE, { search: search.trim(), status, className: className.trim() }, { signal: controller.signal })
        .then(({ data }) => {
          setStudents(data.students || []);
          setTotal(data.total || 0);
          setPages(data.pages || 1);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setError(apiError(err, t("students.loadFailed")));
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [page, search, status, className, reloadKey, t]);

  // Reset to page 1 when filters change.
  useEffect(() => { setPage(1); }, [search, status, className]);

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const params = {};
      if (status !== "all") params.status = status;
      if (className.trim()) params.class = className.trim();
      const { data } = await exportStudents(params);
      const blobUrl = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(apiError(err, t("students.exportFailed")));
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteStudent(pendingDelete.studentId);
      setNotice(t("students.deleted", { studentId: pendingDelete.studentId }));
      setPendingDelete(null);
      reload();
    } catch (err) {
      setError(apiError(err, t("students.deleteFailed")));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page-wrap-wide">
      <PageHero title={t("students.title")} subtitle={t("students.subtitle")}>
        {canWrite && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => setPanel(panel === "create" ? null : "create")}>
              <IconPlus size={14} /> {t("students.addBtn")}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setPanel(panel === "import" ? null : "import")}>
              {t("students.importBtn")}
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary" onClick={handleExport} disabled={exporting}>
          <IconDownload size={14} /> {exporting ? t("students.exporting") : t("students.exportBtn")}
        </button>
      </PageHero>

      <InlineAlert tone="success" onDismiss={() => setNotice(null)} dismissLabel={t("actions.hide")}>{notice}</InlineAlert>

      {panel === "create" && (
        <CreateStudentForm
          onCancel={() => setPanel(null)}
          onCreated={() => { setPanel(null); setNotice(t("students.created")); reload(); }}
        />
      )}
      {panel === "import" && <BulkImportPanel onCancel={() => setPanel(null)} onImported={reload} />}

      <div className="card admin-section">
        <div className="admin-toolbar" role="search" aria-label={t("students.filtersAria")}>
          <div className="form-group">
            <label className="form-label" htmlFor="students-search">{t("students.searchLabel")}</label>
            <input id="students-search" className="form-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("students.searchPlaceholder")} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="students-status">{t("students.statusLabel")}</label>
            <select id="students-status" className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">{t("students.statusAll")}</option>
              <option value="paid">{t("students.statusPaid")}</option>
              <option value="partial">{t("students.statusPartial")}</option>
              <option value="unpaid">{t("students.statusUnpaid")}</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="students-class">{t("students.classLabel")}</label>
            <input id="students-class" className="form-input" value={className} onChange={(e) => setClassName(e.target.value)} />
          </div>
          <button type="button" className="btn btn-ghost" onClick={reload} aria-label={t("adminCommon.refresh")}>
            <IconRefreshCw size={14} />
          </button>
        </div>

        <InlineAlert>{error}</InlineAlert>

        <div className="table-wrap" aria-busy={loading}>
          <table className="data-table" aria-label={t("students.tableAria")}>
            <thead>
              <tr>
                <th scope="col">{t("students.colStudentId")}</th>
                <th scope="col">{t("students.colName")}</th>
                <th scope="col">{t("students.colClass")}</th>
                <th scope="col">{t("students.colFee")}</th>
                <th scope="col">{t("students.colPaid")}</th>
                <th scope="col">{t("students.colStatus")}</th>
                <th scope="col"><span className="sr-only">{t("adminCommon.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="7" className="text-muted">{t("actions.loading")}</td></tr>
              ) : students.length === 0 ? (
                <tr>
                  <td colSpan="7">
                    <div className="empty-state">
                      <div className="empty-state-icon"><IconSearch size={26} /></div>
                      <div className="empty-state-title">{t("students.emptyTitle")}</div>
                    </div>
                  </td>
                </tr>
              ) : students.flatMap((s) => {
                const st = studentStatus(s);
                const rows = [
                  <tr key={s.studentId}>
                    <td className="mono">{s.studentId}</td>
                    <td>{s.name}</td>
                    <td>{s.class}</td>
                    <td>{s.feeAmount}</td>
                    <td>{s.totalPaid ?? 0}</td>
                    <td><span className={`badge ${STATUS_BADGE[st]}`}>{t(`students.status${st[0].toUpperCase()}${st.slice(1)}`)}</span></td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          aria-expanded={expanded === s.studentId}
                          onClick={() => setExpanded(expanded === s.studentId ? null : s.studentId)}
                        >
                          {expanded === s.studentId ? t("actions.hide") : t("actions.viewDetails")}
                        </button>
                        {canWrite && (
                          <>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(s)}>{t("actions.edit")}</button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => setPendingDelete(s)}>{t("actions.delete")}</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>,
                ];
                if (expanded === s.studentId) {
                  rows.push(
                    <tr key={`${s.studentId}-detail`}>
                      <td colSpan="7" style={{ padding: 0 }}>
                        <StudentDetail student={s} canWrite={canWrite} canManageReminders={canManageReminders} onChanged={reload} />
                      </td>
                    </tr>
                  );
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} total={total} loading={loading} onChange={setPage} label={t("students.paginationAria")} />
      </div>

      {canWrite && <RestoreStudentForm onRestored={reload} />}

      {editing && (
        <StudentForm
          student={editing}
          onClose={() => setEditing(null)}
          onSave={() => { setEditing(null); reload(); }}
        />
      )}

      {pendingDelete && (
        <ConfirmationModal
          title={t("students.deleteConfirmTitle")}
          description={t("students.deleteConfirmDesc", { name: pendingDelete.name, studentId: pendingDelete.studentId })}
          confirmLabel={t("actions.delete")}
          loading={deleting}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
