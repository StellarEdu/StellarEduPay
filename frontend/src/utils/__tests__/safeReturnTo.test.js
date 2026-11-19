import { safeReturnTo } from '../safeReturnTo';

describe('safeReturnTo (#1951)', () => {
  test.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['/%5Cevil.example'],
    ['/%5C%5Cevil.example'],
    ['/%2F%2Fevil.example'],
    ['\\\\evil.example'],
    ['https://evil.example'],
    ['http://evil.example/phish'],
    ['javascript:alert(1)'],
    ['/\t/evil.example'],
    ['/%0d%0aevil'],
    ['/%E0%A4%A'],
    [''],
    [undefined],
    [null],
    [['/students']],
  ])('rejects %p and falls back to /dashboard', (input) => {
    expect(safeReturnTo(input)).toBe('/dashboard');
  });

  test('keeps an in-app path with its query and hash', () => {
    expect(safeReturnTo('/students?page=2#top')).toBe('/students?page=2#top');
  });

  test('keeps a plain in-app path', () => {
    expect(safeReturnTo('/dashboard')).toBe('/dashboard');
  });
});
