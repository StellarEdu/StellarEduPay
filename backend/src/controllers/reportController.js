'use strict';

const {
  generateReport,
  reportToCsv,
  getDashboardMetrics,
  generateAccountingCsv,
  ACCOUNTING_SCHEMA_VERSION,
  getDataVersion,
} = require('../services/reportService');
const { get, set, KEYS, TTL } = require('../cache');
const {
  enqueueReportJob,
  getJobStatus,
  setJobProcessing,
  setJobCompleted,
  setJobFailed,
} = require('../queue/reportQueue');
const { ReportJob, REPORT_STATUSES } = require('../models/reportJobModel');
const School = require('../models/schoolModel');

const LARGE_REPORT_THRESHOLD_DAYS = parseInt(process.env.LARGE_REPORT_THRESHOLD_DAYS || '30', 10);

function getDaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

async function getReport(req, res, next) {
  try {
    const { startDate, endDate, format = 'json', schema_version, async: isAsync } = req.query;
    const isLargeReport = getDaysBetween(startDate, endDate) >= LARGE_REPORT_THRESHOLD_DAYS;

    if (isAsync && isLargeReport) {
      const job = await enqueueReportJob({
        schoolId: req.schoolId,
        type: format === 'accounting_csv' ? 'accounting_csv' : 'report',
        startDate,
        endDate,
        timezone: (await School.findOne({ schoolId: req.schoolId }).lean())?.timezone || 'UTC',
        schemaVersion: schema_version || (format === 'accounting_csv' ? ACCOUNTING_SCHEMA_VERSION : null),
      });

      return res.status(202).json({
        jobId: job.jobId,
        status: REPORT_STATUSES.PENDING,
        message: 'Report generation started. Poll /api/reports/jobs/{jobId} for status.',
        statusUrl: job.reportJob.statusUrl,
      });
    }

    if (format === 'accounting_csv') {
      const dataVersion = await getDataVersion(req.schoolId);
      const cacheKey = KEYS.report(req.schoolId, startDate, endDate, dataVersion);
      let cached = get(cacheKey);
      if (cached !== undefined) {
        const csv = cached.csv;
        const version = cached.schemaVersion;
        const s = startDate || null;
        const e = endDate || null;
        let filename;
        if (s && e) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-${s}-to-${e}.csv`;
        else if (s) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-${s}-onwards.csv`;
        else if (e) filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-to-${e}.csv`;
        else filename = `accounting-v${version || schema_version || ACCOUNTING_SCHEMA_VERSION}-all-time.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Export-Schema-Version', String(ACCOUNTING_SCHEMA_VERSION));
        return res.send(csv);
      }

      const { csv, schemaVersion } = await generateAccountingCsv({ schoolId: req.schoolId, startDate, endDate });
      set(cacheKey, { csv, schemaVersion }, TTL.REPORT);

      const s = startDate || null;
      const e = endDate || null;
      let filename;
      if (s && e) filename = `accounting-v${schemaVersion}-${s}-to-${e}.csv`;
      else if (s) filename = `accounting-v${schemaVersion}-${s}-onwards.csv`;
      else if (e) filename = `accounting-v${schemaVersion}-to-${e}.csv`;
      else filename = `accounting-v${schemaVersion}-all-time.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Export-Schema-Version', String(schemaVersion));
      return res.send(csv);
    }

    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const timezone = school?.timezone || 'UTC';
    const dataVersion = await getDataVersion(req.schoolId);
    const cacheKey = KEYS.report(req.schoolId, startDate, endDate, dataVersion);
    let report = get(cacheKey);
    if (report === undefined) {
      report = await generateReport({ schoolId: req.schoolId, startDate, endDate, timezone });
      set(cacheKey, report, TTL.REPORT);
    }

    if (format === 'csv') {
      const s = startDate || null;
      const e = endDate || null;
      let filename;
      if (s && e) filename = `report-${s}-to-${e}.csv`;
      else if (s) filename = `report-${s}-to-all-time.csv`;
      else if (e) filename = `report-all-time-to-${e}.csv`;
      else filename = 'report-all-time.csv';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(reportToCsv(report));
    }

    res.json(report);
  } catch (err) { next(err); }
}

async function getDashboard(req, res, next) {
  try {
    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const cacheKey = `dashboard:${req.schoolId}`;
    let metrics = get(cacheKey);
    if (metrics === undefined) {
      metrics = await getDashboardMetrics({ schoolId: req.schoolId, timezone: school?.timezone || 'UTC' });
      set(cacheKey, metrics, TTL.REPORT);
    }
    res.json(metrics);
  } catch (err) { next(err); }
}

async function getReportJob(req, res, next) {
  try {
    const { jobId } = req.params;
    const job = await ReportJob.findOne({ jobId, schoolId: req.schoolId }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Report job not found' });
    }

    res.json({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      params: job.params,
      error: job.result?.error || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      downloadUrl: job.status === REPORT_STATUSES.COMPLETED ? `/api/reports/jobs/${jobId}/download` : null,
    });
  } catch (err) { next(err); }
}

async function downloadReportJob(req, res, next) {
  try {
    const { jobId } = req.params;
    const { format = 'json' } = req.query;
    const job = await ReportJob.findOne({ jobId, schoolId: req.schoolId }).lean();

    if (!job) {
      return res.status(404).json({ error: 'Report job not found' });
    }

    if (job.status !== REPORT_STATUSES.COMPLETED) {
      return res.status(409).json({
        error: 'Report not ready',
        status: job.status,
        message: 'Report generation is not complete. Poll status endpoint.',
      });
    }

    if (job.type === 'accounting_csv') {
      res.setHeader('Content-Type', 'text/csv');
      const s = job.params.startDate || null;
      const e = job.params.endDate || null;
      let filename;
      if (s && e) filename = `accounting-v${job.result.schemaVersion}-${s}-to-${e}.csv`;
      else if (s) filename = `accounting-v${job.result.schemaVersion}-${s}-onwards.csv`;
      else if (e) filename = `accounting-v${job.result.schemaVersion}-to-${e}.csv`;
      else filename = `accounting-v${job.result.schemaVersion}-all-time.csv`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Export-Schema-Version', String(job.result.schemaVersion));
      return res.send(job.result.csv);
    }

    // Regular report
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      const s = job.params.startDate || null;
      const e = job.params.endDate || null;
      let filename;
      if (s && e) filename = `report-${s}-to-${e}.csv`;
      else if (s) filename = `report-${s}-to-all-time.csv`;
      else if (e) filename = `report-all-time-to-${e}.csv`;
      else filename = 'report-all-time.csv';
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(reportToCsv(job.result.report));
    }

    res.json(job.result.report);
  } catch (err) { next(err); }
}

module.exports = { getReport, getDashboard, getReportJob, downloadReportJob };