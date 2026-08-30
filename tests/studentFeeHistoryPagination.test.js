'use strict';

/**
 * Tests for issue #1416 — paginated archived fee history.
 *
 * GET /api/students/:studentId/fee-history existed but read the whole
 * collection: `.find({ schoolId, studentId }).sort().lean()`. StudentFeeHistory
 * only receives entries once a student's `fees` array passes
 * STUDENT_FEE_HISTORY_CAP, so the response grew with enrolment length — the
 * students whose history someone is auditing are precisely the ones with the
 * most archived rows.
 *
 * The model is mocked; no database is involved.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);

const StudentFeeHistory = require('../backend/src/models/studentFeeHistoryModel');
const {
  getFeeHistory,
  FEE_HISTORY_MAX_LIMIT,
} = require('../backend/src/controllers/studentController');

/** A chainable find() double that records the query it was given. */
function mockFind(rows) {
  const calls = {};
  const chain = {
    sort: jest.fn((arg) => {
      calls.sort = arg;
      return chain;
    }),
    skip: jest.fn((arg) => {
      calls.skip = arg;
      return chain;
    }),
    limit: jest.fn((arg) => {
      calls.limit = arg;
      return chain;
    }),
    lean: jest.fn(async () => rows),
  };
  chain.calls = calls;
  return chain;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const req = (query = {}) => ({
  schoolId: 'SCH-1',
  params: { studentId: 'STU-1' },
  query,
});

let chain;

beforeEach(() => {
  jest.restoreAllMocks();
  chain = mockFind([{ amount: 100 }, { amount: 200 }]);
  jest.spyOn(StudentFeeHistory, 'find').mockReturnValue(chain);
  jest.spyOn(StudentFeeHistory, 'countDocuments').mockResolvedValue(2);
});

describe('getFeeHistory query', () => {
  it('scopes to the school and the student', async () => {
    await getFeeHistory(req(), makeRes(), jest.fn());
    expect(StudentFeeHistory.find).toHaveBeenCalledWith({
      schoolId: 'SCH-1',
      studentId: 'STU-1',
    });
  });

  it('returns newest archived entries first', async () => {
    await getFeeHistory(req(), makeRes(), jest.fn());
    expect(chain.calls.sort).toEqual({ archivedAt: -1 });
  });

  it('applies a default page size instead of reading everything', async () => {
    await getFeeHistory(req(), makeRes(), jest.fn());
    expect(chain.calls.skip).toBe(0);
    expect(chain.calls.limit).toBe(50);
  });

  it('offsets by page', async () => {
    await getFeeHistory(req({ page: '3', limit: '10' }), makeRes(), jest.fn());
    expect(chain.calls.skip).toBe(20);
    expect(chain.calls.limit).toBe(10);
  });

  it('counts with the same filter it queries with', async () => {
    await getFeeHistory(req(), makeRes(), jest.fn());
    expect(StudentFeeHistory.countDocuments).toHaveBeenCalledWith({
      schoolId: 'SCH-1',
      studentId: 'STU-1',
    });
  });
});

describe('page size bounds', () => {
  it('caps an oversized limit', async () => {
    await getFeeHistory(req({ limit: '10000' }), makeRes(), jest.fn());
    expect(chain.calls.limit).toBe(FEE_HISTORY_MAX_LIMIT);
  });

  it('rejects a zero or negative limit in favour of the default', async () => {
    for (const limit of ['0', '-5']) {
      await getFeeHistory(req({ limit }), makeRes(), jest.fn());
      expect(chain.calls.limit).toBe(50);
    }
  });

  it('rejects a non-numeric limit in favour of the default', async () => {
    await getFeeHistory(req({ limit: 'all' }), makeRes(), jest.fn());
    expect(chain.calls.limit).toBe(50);
  });

  it('never offsets by a negative amount', async () => {
    for (const page of ['0', '-3', 'first']) {
      await getFeeHistory(req({ page }), makeRes(), jest.fn());
      expect(chain.calls.skip).toBe(0);
    }
  });
});

describe('response body', () => {
  it('keeps studentId and history, so existing callers still work', async () => {
    const res = makeRes();
    await getFeeHistory(req(), res, jest.fn());
    expect(res.body.studentId).toBe('STU-1');
    expect(res.body.history).toHaveLength(2);
  });

  it('marks the entries as archived for the dashboard to label', async () => {
    const res = makeRes();
    await getFeeHistory(req(), res, jest.fn());
    expect(res.body.archived).toBe(true);
  });

  it('reports the pagination state', async () => {
    StudentFeeHistory.countDocuments.mockResolvedValue(120);
    const res = makeRes();
    await getFeeHistory(req({ page: '2', limit: '50' }), res, jest.fn());
    expect(res.body.pagination).toMatchObject({
      page: 2,
      limit: 50,
      total: 120,
      totalPages: 3,
      hasPrev: true,
    });
  });

  it('says there is no next page on the last one', async () => {
    StudentFeeHistory.countDocuments.mockResolvedValue(2);
    const res = makeRes();
    await getFeeHistory(req(), res, jest.fn());
    expect(res.body.pagination.hasNext).toBe(false);
    expect(res.body.pagination.hasPrev).toBe(false);
  });

  it('says there is a next page when rows remain', async () => {
    StudentFeeHistory.countDocuments.mockResolvedValue(500);
    const res = makeRes();
    await getFeeHistory(req(), res, jest.fn());
    expect(res.body.pagination.hasNext).toBe(true);
  });

  it('handles a student with no archived entries', async () => {
    chain = mockFind([]);
    StudentFeeHistory.find.mockReturnValue(chain);
    StudentFeeHistory.countDocuments.mockResolvedValue(0);
    const res = makeRes();
    await getFeeHistory(req(), res, jest.fn());
    expect(res.body.history).toEqual([]);
    expect(res.body.pagination).toMatchObject({ total: 0, totalPages: 0, hasNext: false });
  });
});

describe('error handling', () => {
  it('forwards a query failure to next() rather than answering 200', async () => {
    StudentFeeHistory.countDocuments.mockRejectedValue(new Error('db down'));
    const next = jest.fn();
    const res = makeRes();
    await getFeeHistory(req(), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    expect(res.body).toBeUndefined();
  });
});
