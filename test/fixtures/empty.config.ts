import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { defineConfigWithJev } from '../../dist/index.js';

export default defineConfigWithJev(
  {
    enabled: true,
    client: {
      systemOne: (async (request: { questions: Record<string, unknown> }) => ({
        model: 'fixture',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            key === 'scope'
              ? { type: 'choice', choice: 'none', confidence: 1 }
              : { type: 'noul', noul: 0 }
          ])
        )
      })) as unknown as TypeSafeClient['systemOne']
    }
  },
  { testDir: '.', testMatch: '*.spec.ts', reporter: [['list']] }
);
