import { useState, useEffect } from "react";
import RequireAdmin from "../components/RequireAdmin";
import PageHero from "../components/PageHero";
import { IconAlertTriangle, IconCheck, IconX, IconPlus, IconRefresh } from "../components/Icons";
import { useTranslation } from "react-i18next";

async function apiCall(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function timeAgo(iso, t) {
  if (!iso) return t("time.never");
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return t("time.justNow");
  if (mins < 60) return t("time.minutesAgo", { mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("time.hoursAgo", { hrs });
  return new Date(iso).toLocaleDateString();
}

const EVENT_OPTIONS = [
  { value: 'payment.confirmed', labelKey: 'webhooks.event.payment.confirmed' },
  { value: 'payment.failed', labelKey: 'webhooks.event.payment.failed' },
  { value: 'dispute.created', labelKey: 'webhooks.event.dispute.created' },
  { value: 'dispute.resolved', labelKey: 'webhooks.event.dispute.resolved' },
  { value: 'payment.test', labelKey: 'webhooks.event.payment.test' },
];

function WebhooksPage() {
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('create');
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({
    url: '',
    subscribedEvents: [],
    isActive: true,
    description: '',
  });
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});

  useEffect(() => {
    fetchEndpoints();
  }, []);

  const fetchEndpoints = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiCall('GET', '/webhook-endpoints');
      setEndpoints(data.endpoints || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleNew = () => {
    setFormMode('create');
    setEditingId(null);
    setFormData({ url: '', subscribedEvents: [], isActive: true, description: '' });
    setFormError(null);
    setShowForm(true);
  };

  const handleEdit = (endpoint) => {
    setFormMode('edit');
    setEditingId(endpoint._id);
    setFormData({
      url: endpoint.url,
      subscribedEvents: endpoint.subscribedEvents || [],
      isActive: endpoint.isActive,
      description: endpoint.description || '',
    });
    setFormError(null);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      if (!formData.url) throw new Error(t('webhooks.urlRequired'));
      if (formData.subscribedEvents.length === 0) throw new Error(t('webhooks.selectAtLeastOne'));

      const payload = { ...formData };
      const path = formMode === 'create'
        ? '/webhook-endpoints'
        : `/webhook-endpoints/${editingId}`;
      const method = formMode === 'create' ? 'POST' : 'PUT';

      await apiCall(method, path, payload);
      setShowForm(false);
      await fetchEndpoints();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('webhooks.deleteConfirm'))) return;
    try {
      await apiCall('DELETE', `/webhook-endpoints/${id}`);
      await fetchEndpoints();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const result = await apiCall('POST', `/webhook-endpoints/${id}/test`);
      setTestResults(prev => ({ ...prev, [id]: result }));
      setTimeout(() => {
        setTestResults(prev => {
          const newResults = { ...prev };
          delete newResults[id];
          return newResults;
        });
      }, 5000);
    } catch (err) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, error: err.message } }));
      setTimeout(() => {
        setTestResults(prev => {
          const newResults = { ...prev };
          delete newResults[id];
          return newResults;
        });
      }, 5000);
    } finally {
      setTestingId(null);
    }
  };

  const handleEventToggle = (eventValue) => {
    setFormData(prev => ({
      ...prev,
      subscribedEvents: prev.subscribedEvents.includes(eventValue)
        ? prev.subscribedEvents.filter(e => e !== eventValue)
        : [...prev.subscribedEvents, eventValue]
    }));
  };

  return (
    <RequireAdmin>
      <div className="page">
        <PageHero title={t("webhooks.title")} subtitle={t("webhooks.subtitle")} />

        {error && (
          <div className="alert alert-danger">
            <IconAlertTriangle /> {error}
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <div className="d-flex justify-content-between align-items-center">
              <h5>{t("webhooks.endpointsHeader")}</h5>
              <button className="btn btn-primary" onClick={handleNew}>
                <IconPlus /> {t("webhooks.newEndpointBtn")}
              </button>
            </div>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="text-center p-4">{t("webhooks.loading")}</div>
            ) : endpoints.length === 0 ? (
              <div className="text-center p-4">{t("webhooks.empty")}</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>{t("webhooks.colUrl")}</th>
                      <th>{t("webhooks.colEvents")}</th>
                      <th>{t("webhooks.colStatus")}</th>
                      <th>{t("webhooks.colLastDelivery")}</th>
                      <th>{t("webhooks.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map(ep => (
                      <tr key={ep._id}>
                        <td className="font-monospace" style={{ fontSize: '0.85em' }}>
                          {ep.url.substring(0, 40)}...
                        </td>
                        <td>
                          <small>{t("webhooks.eventsCount", { count: (ep.subscribedEvents || []).length })}</small>
                        </td>
                        <td>
                          <span className={`badge ${ep.isActive ? 'badge-success' : 'badge-secondary'}`}>
                            {ep.isActive ? t("status.webhook.active") : t("status.webhook.inactive")}
                          </span>
                        </td>
                        <td>
                          <small>{timeAgo(ep.lastDeliveredAt || ep.createdAt, t)}</small>
                        </td>
                        <td>
                          <div className="btn-group btn-group-sm">
                            <button
                              className="btn btn-outline-secondary"
                              onClick={() => handleTest(ep._id)}
                              disabled={testingId === ep._id}
                              title={t("webhooks.sendTestEvent")}
                            >
                              <IconRefresh />
                            </button>
                            <button
                              className="btn btn-outline-secondary"
                              onClick={() => handleEdit(ep)}
                            >
                              {t("actions.edit")}
                            </button>
                            <button
                              className="btn btn-outline-danger"
                              onClick={() => handleDelete(ep._id)}
                            >
                              <IconX />
                            </button>
                          </div>
                          {testResults[ep._id] && (
                            <div className="mt-2">
                              {testResults[ep._id].success ? (
                                <div className="alert alert-success alert-sm mb-0">
                                  <IconCheck /> {t("webhooks.testSuccess")}
                                </div>
                              ) : (
                                <div className="alert alert-danger alert-sm mb-0">
                                  <IconX /> {testResults[ep._id].error}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {showForm && (
          <div className="card mt-4">
            <div className="card-header">
              <h5>{formMode === 'create' ? t("webhooks.newEndpoint") : t("webhooks.editEndpoint")}</h5>
            </div>
            <div className="card-body">
              {formError && <div className="alert alert-danger">{formError}</div>}
              <form onSubmit={handleSubmit}>
                <div className="mb-3">
                  <label className="form-label">{t("webhooks.urlLabel")}</label>
                  <input
                    type="url"
                    className="form-control"
                    value={formData.url}
                    onChange={e => setFormData({ ...formData, url: e.target.value })}
                    placeholder={t("webhooks.urlPlaceholder")}
                    required
                  />
                  <small className="form-text text-muted">{t("webhooks.urlHint")}</small>
                </div>

                <div className="mb-3">
                  <label className="form-label">{t("webhooks.eventsLabel")}</label>
                  <div>
                    {EVENT_OPTIONS.map(opt => (
                      <div key={opt.value} className="form-check">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`event-${opt.value}`}
                          checked={formData.subscribedEvents.includes(opt.value)}
                          onChange={() => handleEventToggle(opt.value)}
                        />
                        <label className="form-check-label" htmlFor={`event-${opt.value}`}>
                          {t(opt.labelKey)}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mb-3">
                  <label className="form-label">{t("webhooks.descriptionLabel")}</label>
                  <input
                    type="text"
                    className="form-control"
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    placeholder={t("webhooks.descriptionPlaceholder")}
                  />
                </div>

                <div className="mb-3 form-check">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="isActive"
                    checked={formData.isActive}
                    onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                  />
                  <label className="form-check-label" htmlFor="isActive">
                    {t("webhooks.activeLabel")}
                  </label>
                </div>

                <div className="d-flex gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? t("webhooks.saving") : t("webhooks.save")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowForm(false)}
                  >
                    {t("actions.cancel")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .alert-sm {
          padding: 0.25rem 0.5rem;
          font-size: 0.85rem;
          margin-bottom: 0;
        }
        .btn-group-sm .btn {
          padding: 0.25rem 0.5rem;
          font-size: 0.85rem;
        }
        .gap-2 {
          gap: 0.5rem;
        }
      `}</style>
    </RequireAdmin>
  );
}

export default WebhooksPage;
