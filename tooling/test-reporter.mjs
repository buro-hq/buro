import { inspect } from 'node:util';

/** Keeps native failure details and summaries while omitting successful test listings. */
export default async function* compact(events) {
  for await (const event of events) {
    const { type, data } = event;

    switch (type) {
      case 'test:fail':
        yield `${data.todo ? 'TODO' : 'FAIL'} ${data.name}\n`;
        yield `${data.file}:${data.line}:${data.column}\n`;
        yield inspect(data.details.error, {
          depth: null,
          colors: false,
        }) + '\n';
        break;
      case 'test:pass': {
        const hasAnnotation = Boolean(data.skip || data.todo);

        if (hasAnnotation) {
          const annotation = data.skip || data.todo;
          const reason = typeof annotation === 'string' ? ': ' + annotation : '';

          yield `${data.skip ? 'SKIP' : 'TODO'} ${data.name}${reason}\n`;
        }

        break;
      }
      case 'test:coverage':
        yield inspect(data.summary, {
          depth: null,
          colors: false,
        }) + '\n';
        break;
      case 'test:diagnostic':
        yield data.message + '\n';
        break;
      case 'test:stdout':
      case 'test:stderr':
        yield data.message;
        break;
    }
  }
}
