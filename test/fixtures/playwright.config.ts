import { defineConfigWithJev } from '../../dist/index.js';

export default defineConfigWithJev(
  { enabled: false },
  { testDir: '.', testMatch: '*.spec.ts', reporter: [['list']] }
);
