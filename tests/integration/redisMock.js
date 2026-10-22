'use strict';

class MockRedis {
  constructor() {
    this.status = 'ready';
    this.store = new Map();
    this.listeners = new Map();
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    if (event === 'ready') queueMicrotask(listener);
    return this;
  }

  once(event, listener) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter((entry) => entry !== listener));
    return this;
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) || []) listener(...args);
    return this;
  }

  connect() {
    this.status = 'ready';
    this.emit('ready');
    return Promise.resolve();
  }

  duplicate() {
    return new MockRedis();
  }

  async quit() {
    this.status = 'end';
    this.emit('end');
    return 'OK';
  }

  disconnect() {
    this.status = 'end';
    this.emit('end');
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, String(value));
    return 'OK';
  }

  async del(...keys) {
    return keys.flat().reduce((count, key) => count + (this.store.delete(key) ? 1 : 0), 0);
  }

  async exists(...keys) {
    return keys.flat().filter((key) => this.store.has(key)).length;
  }

  async incr(key) {
    const next = Number(await this.get(key) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire() { return 1; }
  async pexpire() { return 1; }
  async ttl() { return -1; }
  async pttl() { return -1; }
  async eval() { return 1; }
  async evalsha() { return 1; }
  async hget() { return null; }
  async hset() { return 1; }
  async hdel() { return 1; }
  async publish() { return 0; }
  async subscribe() { return 'OK'; }
  async unsubscribe() { return 'OK'; }
}

module.exports = MockRedis;
module.exports.default = MockRedis;
