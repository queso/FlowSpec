/**
 * Configuration file tests for FlowSpec
 *
 * These tests verify that the project configuration files exist and contain
 * the required settings from PRD-0001.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..');

describe('Project Configuration', () => {
  it('should have valid package.json with required dependencies', () => {
    const packageJsonPath = join(PROJECT_ROOT, 'package.json');
    expect(existsSync(packageJsonPath)).toBe(true);

    const content = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    // Check key dependencies
    expect(pkg.dependencies['agent-browser']).toBeDefined();
    expect(pkg.devDependencies['express']).toBeDefined();
    expect(pkg.devDependencies['typescript']).toBeDefined();
    expect(pkg.devDependencies['vitest']).toBeDefined();
  });

  it('should have valid tsconfig.json with strict mode', () => {
    const tsconfigPath = join(PROJECT_ROOT, 'tsconfig.json');
    expect(existsSync(tsconfigPath)).toBe(true);

    const content = readFileSync(tsconfigPath, 'utf-8');
    const tsconfig = JSON.parse(content);

    expect(tsconfig.compilerOptions).toBeDefined();
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it('should have valid vitest.config.ts', () => {
    const vitestConfigPath = join(PROJECT_ROOT, 'vitest.config.ts');
    expect(existsSync(vitestConfigPath)).toBe(true);

    const content = readFileSync(vitestConfigPath, 'utf-8');
    expect(content.includes('defineConfig') || content.includes('export default')).toBe(true);
  });
});
