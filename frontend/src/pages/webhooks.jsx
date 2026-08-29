import { useState, useEffect } from "react";
import RequireAdmin from "../components/RequireAdmin";
import PageHero from "../components/PageHero";
import { IconAlertTriangle, IconCheck, IconX, IconPlus, IconRefresh } from "../components/Icons";

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

function timeAgo(iso) {
  if (!iso) return "Never";
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

const EVENT_OPTIONS = [
  { value: 'payment.confirmed', label: 'Payment Confirmed' },
  { value: 'payment.failed', label: 'Payment Failed' },
  { value: 'dispute.created', label: 'Dispute Created' },
  { value: 'dispute.resolved', label: 'Dispute Resolved' },
  { value: 'payment.test', label: 'Test Event' },
];

function WebhooksPage() {
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
      if (!formData.url) throw new Error('URL is required');
      if (formData.subscribedEvents.length === 0) throw new Error('Select at least one event');

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
    if (!window.confirm('Are you sure you want to delete this webhook endpoint?')) return;
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
        <PageHero title="Webhook Endpoints" subtitle="Configure and manage webhook integrations" />

        {error && (
          <div className="alert alert-danger">
            <IconAlertTriangle /> {error}
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <div className="d-flex justify-content-between align-items-center">
              <h5>Endpoints</h5>
              <button className="btn btn-primary" onClick={handleNew}>
                <IconPlus /> New Endpoint
              </button>
            </div>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="text-center p-4">Loading webhooks...</div>
            ) : endpoints.length === 0 ? (
              <div className="text-center p-4">No webhook endpoints configured</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th>Events</th>
                      <th>Status</th>
                      <th>Last Delivery</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map(ep => (
                      <tr key={ep._id}>
                        <td className="font-monospace" style={{ fontSize: '0.85em' }}>
                          {ep.url.substring(0, 40)}...
                        </td>
                        <td>
                          <small>{(ep.subscribedEvents || []).length} events</small>
                        </td>
                        <td>
                          <span className={`badge ${ep.isActive ? 'badge-success' : 'badge-secondary'}`}>
                            {ep.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td>
                          <small>{timeAgo(ep.lastDeliveredAt || ep.createdAt)}</small>
                        </td>
                        <td>
                          <div className="btn-group btn-group-sm">
                            <button
                              className="btn btn-outline-secondary"
                              onClick={() => handleTest(ep._id)}
                              disabled={testingId === ep._id}
                              title="Send test event"
                            >
                              <IconRefresh />
                            </button>
                            <button
                              className="btn btn-outline-secondary"
                              onClick={() => handleEdit(ep)}
                            >
                              Edit
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
                                  <IconCheck /> Test sent successfully
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
              <h5>{formMode === 'create' ? 'New Webhook Endpoint' : 'Edit Webhook Endpoint'}</h5>
            </div>
            <div className="card-body">
              {formError && <div className="alert alert-danger">{formError}</div>}
              <form onSubmit={handleSubmit}>
                <div className="mb-3">
                  <label className="form-label">Webhook URL *</label>
                  <input
                    type="url"
                    className="form-control"
                    value={formData.url}
                    onChange={e => setFormData({ ...formData, url: e.target.value })}
                    placeholder="https://example.com/webhook"
                    required
                  />
                  <small className="form-text text-muted">Must be HTTPS from a public domain</small>
                </div>

                <div className="mb-3">
                  <label className="form-label">Subscribe to Events *</label>
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
                          {opt.label}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mb-3">
                  <label className="form-label">Description</label>
                  <input
                    type="text"
                    className="form-control"
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    placeholder="e.g., Notify accounting system of payments"
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
                    Active
                  </label>
                </div>

                <div className="d-flex gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShowForm(false)}
                  >
                    Cancel
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
