import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.pytest_cache/**',
      '.mypy_cache/**',
      '.ruff_cache/**',
      '.hypothesis/**',
      'packages/contracts/src/generated/**',
      'fallback/python/**',
      'models/**',
      'runtime/**',
      'campaigns/**',
      'logs/**',
      'benchmarks/raw/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
