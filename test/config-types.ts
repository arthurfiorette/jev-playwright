import { defineConfigWithJev } from '../src/index.js';

defineConfigWithJev(
  {
    enabled: true,
    include: ['src/**'],
    createQuestion(test, key) {
      return `${key}: ${test.title}`;
    },
    beforeRequest(request, { tests }) {
      return { ...request, state: { tests: tests.length } };
    }
  },
  { use: { trace: 'on-first-retry' }, reporter: [['list']] }
);

// @ts-expect-error Jev reporter options require a boolean enabled value.
defineConfigWithJev({ enabled: 'yes' }, {});

// @ts-expect-error Unknown Jev reporter options must be rejected.
defineConfigWithJev({ enabled: true, unknownOption: 1 }, {});
