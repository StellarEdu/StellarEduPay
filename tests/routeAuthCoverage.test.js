'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-secret-key-for-route-auth-coverage';

const studentRoutes = require('../backend/src/routes/studentRoutes');
const feeRoutes = require('../backend/src/routes/feeRoutes');
const schoolRoutes = require('../backend/src/routes/schoolRoutes');

const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getRouteInfo(layer, prefix = '') {
  if (!layer.route) {
    return [];
  }

  const path = `${prefix}${layer.route.path}`;
  const methods = Object.keys(layer.route.methods)
    .filter((method) => layer.route.methods[method])
    .map((method) => method.toUpperCase());
  const middlewareNames = layer.route.stack.map((routeLayer) => routeLayer.handle.name || '<anonymous>');

  return [{ path, methods, middlewareNames }];
}

function collectRoutes(router, prefix = '') {
  return router.stack.flatMap((layer) => {
    if (layer.route) {
      return getRouteInfo(layer, prefix);
    }

    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const nestedPrefix = layer.regexp && layer.regexp.fast_slash ? prefix : `${prefix}${layer.regexp.source.replace('^\\', '').replace('\\/?(?=\\/|$)', '')}`;
      return collectRoutes(layer.handle, nestedPrefix);
    }

    return [];
  });
}

describe('Route auth coverage for student, fee, and school mutating endpoints', () => {
  const groupedRoutes = [
    { router: studentRoutes, prefix: '/api/students' },
    { router: feeRoutes, prefix: '/api/fees' },
    { router: schoolRoutes, prefix: '/api/schools' },
  ];

  const protectedRoutes = [];
  const unprotectedRoutes = [];

  groupedRoutes.forEach(({ router, prefix }) => {
    collectRoutes(router, prefix).forEach((route) => {
      const hasMutatingMethod = route.methods.some((method) => mutatingMethods.has(method));
      if (!hasMutatingMethod) {
        return;
      }

      const hasAuth = route.middlewareNames.includes('requireAdminAuth');
      if (hasAuth) {
        protectedRoutes.push(route);
      } else {
        unprotectedRoutes.push(route);
      }
    });
  });

  it('ensures all mutating routes have requireAdminAuth middleware', () => {
    if (unprotectedRoutes.length > 0) {
      const failureMessage = unprotectedRoutes
        .map((route) => `${route.methods.join('|')} ${route.path} -> ${route.middlewareNames.join(', ')}`)
        .join('\n');
      throw new Error(`Found mutating routes without requireAdminAuth:\n${failureMessage}`);
    }
  });

  it('sanity-checks that there is at least one protected mutating route', () => {
    expect(protectedRoutes.length).toBeGreaterThan(0);
  });
});
