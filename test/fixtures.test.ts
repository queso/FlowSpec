import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'pages');

describe('HTML Test Fixtures', () => {
  it('should have all required HTML fixture files', () => {
    expect(existsSync(join(FIXTURES_DIR, 'login.html'))).toBe(true);
    expect(existsSync(join(FIXTURES_DIR, 'dashboard.html'))).toBe(true);
    expect(existsSync(join(FIXTURES_DIR, 'forms.html'))).toBe(true);
  });

  it('should have valid HTML5 structure in fixtures', () => {
    const files = ['login.html', 'dashboard.html', 'forms.html'];

    for (const file of files) {
      const html = readFileSync(join(FIXTURES_DIR, file), 'utf-8');
      expect(html).toMatch(/<!DOCTYPE\s+html>/i);
      expect(html).toMatch(/<html[^>]*>/i);
      expect(html).toMatch(/<\/html>/i);
    }
  });

  it('login.html should have email and password inputs', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'login.html'), 'utf-8');
    expect(html).toMatch(/<input[^>]*type=["']email["'][^>]*>/i);
    expect(html).toMatch(/<input[^>]*type=["']password["'][^>]*>/i);
  });

  it('forms.html should have text input, select, and textarea', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'forms.html'), 'utf-8');
    expect(html).toMatch(/<input[^>]*type=["']text["'][^>]*>/i);
    expect(html).toMatch(/<select[^>]*>/i);
    expect(html).toMatch(/<textarea[^>]*>/i);
  });
});
