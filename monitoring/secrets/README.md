# Alertmanager receiver secrets (#2018)

`docker-compose.monitoring.yml` mounts this directory read-only at
`/etc/alertmanager/secrets/`. `monitoring/alertmanager.yml` reads each
receiver credential from a file here. Create the files before starting the
monitoring stack:

| File                     | Contents                                              | Used by            |
|--------------------------|-------------------------------------------------------|--------------------|
| `slack_webhook_url`      | Slack incoming-webhook URL                            | `slack-*` receivers |
| `pagerduty_routing_key`  | PagerDuty Events API v2 integration (routing) key     | `pagerduty-critical` |
| `watchdog_url`           | Dead-man's-switch URL that expects a periodic ping    | `watchdog-heartbeat` |

Example:

```bash
echo -n 'https://hooks.slack.com/services/XXX/YYY/ZZZ' > monitoring/secrets/slack_webhook_url
echo -n 'your-pagerduty-routing-key'                    > monitoring/secrets/pagerduty_routing_key
echo -n 'https://hc-ping.com/your-check-uuid'           > monitoring/secrets/watchdog_url
```

Every file in this directory except this README is git-ignored. Never commit
real secrets.

## Testing the pipeline

Fire a test alert through Alertmanager's API and confirm it reaches the
receiver:

```bash
curl -s -XPOST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[
  {"labels": {"alertname": "AlertPipelineTest", "severity": "critical"},
   "annotations": {"summary": "Test alert from monitoring/secrets/README.md"}}
]'
```
