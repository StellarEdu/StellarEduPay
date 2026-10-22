'use strict';

/**
 * Issue #1816 — bulk student import: dry-run preview and downloadable template.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';

const fs = require('fs');
const path = require('path');
const { buildBulkImportTemplateCsv, BULK_IMPORT_TEMPLATE_HEADERS } = require('../backend/src/controllers/studentController');

const ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/routes/studentRoutes.js'),
  'utf8',
);

describe('buildBulkImportTemplateCsv (#1816)', () => {
  it('starts with the accepted column headers in order', () => {
    const [headerLine] = buildBulkImportTemplateCsv().split('\n');
    expect(headerLine).toBe('studentId,name,class,feeAmount,parentEmail,parentPhone');
    expect(BULK_IMPORT_TEMPLATE_HEADERS).toEqual(headerLine.split(','));
  });

  it('includes one example row that uses the first known class', () => {
    const lines = buildBulkImportTemplateCsv(['Grade 1', 'Grade 2']).split('\n');
    expect(lines[1]).toBe('STU001,Jane Doe,Grade 1,,parent@example.com,+15555550100');
  });

  it('lists the school class options in a comment line when classes exist', () => {
    const csv = buildBulkImportTemplateCsv(['Grade 1', 'Grade 2']);
    expect(csv).toContain('# Known classes: Grade 1, Grade 2');
  });

  it('omits the class comment when the school has no fee structures', () => {
    const csv = buildBulkImportTemplateCsv([]);
    expect(csv).not.toContain('# Known classes');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('has a row that the importer would parse with the same column names', () => {
    const [headerLine, exampleLine] = buildBulkImportTemplateCsv(['Grade 1']).split('\n');
    const row = Object.fromEntries(
      headerLine.split(',').map((h, i) => [h, exampleLine.split(',')[i]]),
    );
    expect(row.studentId).toMatch(/^[A-Za-z0-9_-]{3,20}$/);
    expect(row.class).toBe('Grade 1');
  });
});

describe('bulk import routing and dry-run wiring (#1816)', () => {
  it('registers GET /bulk/template.csv for staff and read-only users', () => {
    expect(ROUTES_SRC).toMatch(
      /router\.get\('\/bulk\/template\.csv', requireSchoolAuth\(\['owner', 'staff', 'read_only'\]\), getBulkImportTemplate\)/,
    );
  });

  it('keeps the existing POST /bulk route unchanged', () => {
    expect(ROUTES_SRC).toContain("router.post('/bulk', requireSchoolAuth(['owner', 'staff'])");
  });

  it('returns the dry-run preview before any insertMany call', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../backend/src/controllers/studentController.js'),
      'utf8',
    );
    const dryRunIdx = src.indexOf("req.query.dryRun === 'true'");
    const insertIdx = src.indexOf('Student.insertMany(chunk');
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(dryRunIdx);
  });
});
