import { parseSync, Visitor } from 'oxc-parser';

/** Location of a Playwright-discovered test, indexed into its matching descriptor. */
export interface TestLocation {
  index: number;
  line: number;
  column?: number;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] ?? 0) <= position) low = middle;
    else high = middle;
  }
  return low + 1;
}

function precedingComments(
  source: string,
  comments: ReadonlyArray<{ start: number; end: number }>,
  start: number
): string[] {
  const found: string[] = [];
  let cursor = start;

  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    if (!comment || comment.end > cursor) continue;

    const gap = source.slice(comment.end, cursor);
    const before = source.slice(source.lastIndexOf('\n', comment.start - 1) + 1, comment.start);
    // A blank line or an inline comment on the previous statement breaks ownership.
    if (!/^\s*$/.test(gap) || (gap.match(/\n/g)?.length ?? 0) !== 1 || before.trim()) break;

    found.unshift(source.slice(comment.start, comment.end));
    cursor = comment.start;
  }

  return found;
}

/** Extract only each discovered test callback body and its immediately preceding comments. */
export function extractTestBodies(
  file: string,
  source: string,
  locations: TestLocation[]
): Map<number, string> {
  const parsed = parseSync(file, source, { sourceType: 'unambiguous' });
  if (parsed.errors.length) throw new Error(`Cannot parse ${file}: ${parsed.errors[0]?.message}`);

  const starts = lineStarts(source);
  const lines = new Set(locations.map((location) => location.line));
  const bodies = new Map<number, Array<{ column: number; text: string }>>();

  new Visitor({
    CallExpression(call) {
      const line = lineAt(starts, call.start);
      if (!lines.has(line)) return;

      const callback = call.arguments.at(-1);
      if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression')
        return;

      const body = callback.body;
      if (!body) return;
      const code =
        body.type === 'BlockStatement'
          ? source.slice(body.start + 1, body.end - 1)
          : source.slice(body.start, body.end);
      const comments = precedingComments(source, parsed.comments, call.start);
      const text = [...comments, code].join('\n').trim();
      const entries = bodies.get(line) ?? [];
      entries.push({ column: call.start - (starts[line - 1] ?? 0) + 1, text });
      bodies.set(line, entries);
    }
  }).visit(parsed.program);

  const result = new Map<number, string>();
  for (const location of locations) {
    const matches =
      bodies
        .get(location.line)
        ?.filter((body) => location.column === undefined || body.column === location.column) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Cannot locate test callback at ${file}:${location.line}:${location.column ?? '?'}`
      );
    }
    result.set(location.index, matches[0]?.text ?? '');
  }

  return result;
}
