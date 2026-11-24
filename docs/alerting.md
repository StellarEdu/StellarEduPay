# Alerting

Prometheus evaluates the rules in `monitoring/alerts/`. Firing alerts are sent
to **Alertmanager**, which routes them to receivers (#2018). Without
Alertmanager, alerts only appear as "firing" in the Prometheus UI and nobody is
notified.

## Routing

Defined in `monitoring/alertmanager.yml`:

| Alert                           | Receiver              |
|---------------------------------|-----------------------|
| `severity="critical"`           | PagerDuty + `#alerts-critical` Slack |
| `severity="warning"`            | `#alerts-warnings` Slack |
| `Watchdog` (always firing)      | Dead-man's-switch webhook |

Critical alerts also suppress the warning alert for the same `alertname` and
`instance`.

### Watchdog

`Watchdog` (`monitoring/alerts/watchdog.yml`) always fires. Its webhook
receiver expects a steady stream of pings from Alertmanager. If the pings stop,
something in the chain (Prometheus → Alertmanager → receiver) is broken, and
the dead-man's-switch service should notify a human. Use a service such as
Healthchecks.io or Dead Man's Snitch, and put its URL in
`monitoring/secrets/watchdog_url`.

## Docker Compose (local / single host)

1. Create the receiver secrets described in
   [`monitoring/secrets/README.md`](../monitoring/secrets/README.md).
2. Start the stack:
   ```bash
   docker compose -f docker-compose.monitoring.yml up -d
   ```
3. Check the Alertmanager UI at <http://localhost:9093> and the Prometheus
   **Alerts** page at <http://localhost:9090/alerts>. Alertmanager should be
   listed under **Status → Alertmanagers** in Prometheus.
4. Fire a test alert (command in `monitoring/secrets/README.md`) and confirm it
   reaches the Slack channel.

## Kubernetes

Use [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack),
which installs Prometheus, Alertmanager and the Prometheus Operator.

1. Install the chart with the release name `kube-prometheus-stack` in the
   `monitoring` namespace. The generated rules select on the label
   `release: kube-prometheus-stack`.
2. Generate the `PrometheusRule` objects from the alert files:
   ```bash
   scripts/generate-prometheus-rules-crd.sh monitoring
   kubectl apply -f k8s/monitoring/prometheus-rules.yaml
   ```
   Regenerate and re-apply whenever files in `monitoring/alerts/` change.
3. Configure Alertmanager receivers with the same routing as
   `monitoring/alertmanager.yml`. Store the Slack, PagerDuty and Watchdog
   credentials in Kubernetes Secrets and reference them from the chart's
   `alertmanager.alertmanagerSpec.secrets` values.

## Verifying the pipeline

- Prometheus: `Status → Alertmanagers` shows the endpoint as `UP`.
- Alertmanager: `http://<alertmanager>:9093/#/status` shows the loaded config.
- End to end: send a test alert (see `monitoring/secrets/README.md`) and
  confirm it arrives at the receiver.
