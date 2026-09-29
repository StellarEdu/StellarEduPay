/**
 * @jest-environment jsdom
 */

/**
 * #1579 — every admin route must be guarded centrally: rendering any route in
 * ADMIN_ROUTES while logged out must redirect to /login and must never mount
 * the page (so no admin API calls fire).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

const mockReplace = jest.fn();
let mockPathname = '/';
jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: mockPathname,
    asPath: mockPathname,
    replace: mockReplace,
  }),
}));

jest.mock('next/link', () => ({ children, href, ...rest }) => (
  <a href={href} {...rest}>{children}</a>
));

let mockAuth = { isAdmin: false, checked: true };
jest.mock('../../hooks/AdminAuthContext', () => ({
  useAdminAuthContext: () => mockAuth,
}));

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import RouteShell from '../RouteShell';
import { ADMIN_ROUTES } from '../../config/routes';

function Page() {
  return <div data-testid="protected-page">secret</div>;
}

function renderRoute(pathname) {
  mockPathname = pathname;
  return render(
    <RouteShell pathname={pathname}>
      <Page />
    </RouteShell>
  );
}

beforeEach(() => {
  mockReplace.mockClear();
  mockAuth = { isAdmin: false, checked: true };
});

describe('RouteShell — central admin guard (#1579)', () => {
  it('covers the previously unguarded admin pages', () => {
    expect(ADMIN_ROUTES).toEqual(
      expect.arrayContaining(['/fees', '/fee-adjustments', '/reports'])
    );
  });

  it.each(ADMIN_ROUTES)('redirects %s to /login when there is no session', (route) => {
    renderRoute(route);

    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(route)}`
    );
  });

  it.each(ADMIN_ROUTES)('does not render %s while the session check is pending', (route) => {
    mockAuth = { isAdmin: false, checked: false };
    renderRoute(route);

    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)('renders %s for an authenticated admin', (route) => {
    mockAuth = { isAdmin: true, checked: true };
    renderRoute(route);

    expect(screen.getByTestId('protected-page')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it.each(['/', '/pay-fees', '/login'])('leaves public route %s unguarded', (route) => {
    renderRoute(route);

    expect(screen.getByTestId('protected-page')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
