import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// globals: false, so RTL's automatic cleanup is not installed. Do it here.
afterEach(() => {
  cleanup();
});
