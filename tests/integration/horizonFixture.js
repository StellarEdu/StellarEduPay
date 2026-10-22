'use strict';
const http = require('http');

function startHorizonFixture() {
  const transactions = new Map();
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/transactions\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const record = transactions.get(match[1]);
      res.setHeader('content-type', 'application/json');
      res.statusCode = record ? 200 : 404;
      res.end(JSON.stringify(record || { title: 'Not Found', status: 404 }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.statusCode = 404;
    res.end(JSON.stringify({ title: 'Not Found', status: 404 }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    addTransaction(hash, transaction) { transactions.set(hash, { hash, ...transaction }); },
  })));
}
module.exports = { startHorizonFixture };
