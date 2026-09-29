'use strict';
// Minimal axios stub for backend tests where axios is not installed.
// Tests that need real axios behaviour should mock the module in-test via jest.mock().
const axios = {
  create: () => axios,
  get:    jest.fn(),
  post:   jest.fn(),
  put:    jest.fn(),
  patch:  jest.fn(),
  delete: jest.fn(),
  interceptors: {
    request:  { use: jest.fn() },
    response: { use: jest.fn() },
  },
  defaults: { headers: { common: {} } },
};
module.exports = axios;
module.exports.default = axios;
