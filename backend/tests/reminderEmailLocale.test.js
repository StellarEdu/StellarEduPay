'use strict';

const { renderEmailTemplate } = require('../src/utils/templateRenderer');

describe('reminderEmail template locale selection', () => {
  it('renders French translations when locale is fr', () => {
    const { text } = renderEmailTemplate('reminderEmail', {
      locale: 'fr',
      studentName: 'Amina',
      studentId: 'S1',
      className: '5A',
      schoolName: 'Ecole X',
      feeAmount: 100,
      outstanding: 100,
    });
    expect(text).toContain('Cher Parent/Tuteur,');
  });

  it('renders Hausa translations when locale is ha', () => {
    const { html } = renderEmailTemplate('reminderEmail', {
      locale: 'ha',
      studentName: 'Amina',
      studentId: 'S1',
      className: '5A',
      schoolName: 'School X',
      feeAmount: 100,
      outstanding: 100,
    });
    expect(html).toContain('Masoyin Iyaye/Mai Kula,');
  });

  it('falls back to English when locale is missing or unsupported', () => {
    const { text } = renderEmailTemplate('reminderEmail', {
      locale: 'xx',
      studentName: 'Amina',
      studentId: 'S1',
      className: '5A',
      schoolName: 'School X',
      feeAmount: 100,
      outstanding: 100,
    });
    expect(text).toContain('Dear Parent/Guardian,');
  });

  it('defaults to English when no locale is provided', () => {
    const { text } = renderEmailTemplate('reminderEmail', {
      studentName: 'Amina',
      studentId: 'S1',
      className: '5A',
      schoolName: 'School X',
      feeAmount: 100,
      outstanding: 100,
    });
    expect(text).toContain('Dear Parent/Guardian,');
  });
});
