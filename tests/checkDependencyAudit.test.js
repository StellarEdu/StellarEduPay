'use strict';

const { findUnexceptedVulnerabilities } = require('../scripts/check-dependency-audit');

function vuln(name, severity, advisoryUrls) {
  return {
    name,
    severity,
    via: advisoryUrls.map((url) => ({ url })),
  };
}

describe('findUnexceptedVulnerabilities', () => {
  it('flags a high-severity advisory with no exception', () => {
    const vulnerabilities = {
      'form-data': vuln('form-data', 'high', ['https://github.com/advisories/GHSA-hmw2-7cc7-3qxx']),
    };

    const failures = findUnexceptedVulnerabilities(vulnerabilities, [], 'backend', '2026-07-20');

    expect(failures).toEqual([
      { package: 'form-data', severity: 'high', advisoryIds: ['GHSA-hmw2-7cc7-3qxx'] },
    ]);
  });

  it('does not flag moderate/low severity advisories', () => {
    const vulnerabilities = {
      'js-yaml': vuln('js-yaml', 'moderate', ['https://github.com/advisories/GHSA-mh29-5h37-fv8m']),
    };

    expect(findUnexceptedVulnerabilities(vulnerabilities, [], 'backend', '2026-07-20')).toEqual([]);
  });

  it('is silenced by a current, matching exception', () => {
    const vulnerabilities = {
      'form-data': vuln('form-data', 'high', ['https://github.com/advisories/GHSA-hmw2-7cc7-3qxx']),
    };
    const exceptions = [
      {
        id: 'GHSA-hmw2-7cc7-3qxx',
        package: 'form-data',
        path: 'backend',
        expires: '2026-12-31',
      },
    ];

    expect(findUnexceptedVulnerabilities(vulnerabilities, exceptions, 'backend', '2026-07-20')).toEqual([]);
  });

  it('treats an expired exception as absent', () => {
    const vulnerabilities = {
      'form-data': vuln('form-data', 'high', ['https://github.com/advisories/GHSA-hmw2-7cc7-3qxx']),
    };
    const exceptions = [
      {
        id: 'GHSA-hmw2-7cc7-3qxx',
        package: 'form-data',
        path: 'backend',
        expires: '2026-01-01',
      },
    ];

    const failures = findUnexceptedVulnerabilities(vulnerabilities, exceptions, 'backend', '2026-07-20');

    expect(failures).toHaveLength(1);
  });

  it('does not apply an exception scoped to a different package path', () => {
    const vulnerabilities = {
      'form-data': vuln('form-data', 'high', ['https://github.com/advisories/GHSA-hmw2-7cc7-3qxx']),
    };
    const exceptions = [
      {
        id: 'GHSA-hmw2-7cc7-3qxx',
        package: 'form-data',
        path: 'frontend',
        expires: '2026-12-31',
      },
    ];

    const failures = findUnexceptedVulnerabilities(vulnerabilities, exceptions, 'backend', '2026-07-20');

    expect(failures).toHaveLength(1);
  });

  it('ignores transitive-only entries whose via list has no advisory objects', () => {
    const vulnerabilities = {
      bullmq: { name: 'bullmq', severity: 'high', via: ['uuid'] },
    };

    expect(findUnexceptedVulnerabilities(vulnerabilities, [], 'backend', '2026-07-20')).toEqual([]);
  });
});
