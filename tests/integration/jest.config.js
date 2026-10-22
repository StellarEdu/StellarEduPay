module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.integration.test.js'],
  setupFiles: ['<rootDir>/tests/integration/setupEnv.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.js'],
  testTimeout: 120000,
  maxWorkers: 2,
  moduleDirectories: ['node_modules', 'backend/node_modules'],
  moduleNameMapper: {
    '^ioredis$': '<rootDir>/tests/integration/redisMock.js',
  },
};
