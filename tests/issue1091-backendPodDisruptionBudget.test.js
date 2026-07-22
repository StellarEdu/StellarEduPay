'use strict';

/**
 * Tests for Issue #1091 — no PodDisruptionBudget for the backend deployment.
 *
 * Acceptance criteria:
 *   1. A PodDisruptionBudget exists for the backend deployment.
 *   2. It constrains voluntary disruption so at least one of the 2 replicas
 *      stays available (minAvailable >= 1, or an equivalent maxUnavailable).
 *
 * The actual "simulated node drain against a test cluster" half of the
 * acceptance criteria requires a live cluster and is out of scope for this
 * Jest suite; this validates the manifest statically instead.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const K8S_DIR = path.join(__dirname, '..', 'deploy', 'k8s');

function loadYaml(filename) {
  const raw = fs.readFileSync(path.join(K8S_DIR, filename), 'utf8');
  return yaml.load(raw);
}

describe('Issue #1091 — backend PodDisruptionBudget', () => {
  const deployment = loadYaml('backend-deployment.yaml');
  const pdb = loadYaml('backend-pdb.yaml');

  it('the backend Deployment still runs 2 replicas', () => {
    expect(deployment.kind).toBe('Deployment');
    expect(deployment.spec.replicas).toBe(2);
  });

  it('a PodDisruptionBudget resource exists', () => {
    expect(pdb.kind).toBe('PodDisruptionBudget');
    expect(pdb.apiVersion).toBe('policy/v1');
  });

  it('selects the backend deployment pods', () => {
    expect(pdb.spec.selector.matchLabels).toEqual(deployment.spec.selector.matchLabels);
  });

  it('guarantees at least one pod survives a voluntary disruption', () => {
    const { minAvailable, maxUnavailable } = pdb.spec;

    if (minAvailable !== undefined) {
      expect(minAvailable).toBeGreaterThanOrEqual(1);
    } else if (maxUnavailable !== undefined) {
      expect(maxUnavailable).toBeLessThan(deployment.spec.replicas);
    } else {
      throw new Error('PodDisruptionBudget must define minAvailable or maxUnavailable');
    }
  });
});
