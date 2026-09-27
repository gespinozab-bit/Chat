import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Load the same browser module without transpiling or duplicating the parser.
const source = readFileSync(join(__dirname, '../public/sse-parser.js'), 'utf8');
const createParser = runInNewContext(source.replace('export function', 'function') + '\ncreateSseParser;') as
  (callback: (event: string, data: unknown) => void) => { push(text: string, final?: boolean): void };

describe('Parser SSE del navegador', () => {
  it.each(['\n', '\r\n', '\r'])('conserva eventos partidos usando %j', (newline) => {
    const receive = jest.fn();
    const parser = createParser(receive);
    const data = { delta: '¡Hola! 🌎\n"texto"' };
    const wire = `: comentario${newline}event: content${newline}data: ${JSON.stringify(data)}${newline}${newline}` +
      `event: completed${newline}data: {"status":"completed"}${newline}${newline}`;
    const decoder = new TextDecoder();
    for (const byte of new TextEncoder().encode(wire)) {
      parser.push(decoder.decode(new Uint8Array([byte]), { stream: true }));
    }
    parser.push(decoder.decode(), true);
    expect(receive.mock.calls).toEqual([
      ['content', data], ['completed', { status: 'completed' }],
    ]);
  });

  it('procesa varios eventos juntos y conserva el siguiente incompleto', () => {
    const receive = jest.fn();
    const parser = createParser(receive);
    parser.push('event: content\ndata: {"delta":"A"}\n\nevent: content\ndata: {"delta":"B"}\n\nevent: content\ndata: {"delta":');
    expect(receive).toHaveBeenCalledTimes(2);
    parser.push('"C"}\n');
    expect(receive).toHaveBeenCalledTimes(2);
    parser.push('\n');
    expect(receive).toHaveBeenLastCalledWith('content', { delta: 'C' });
  });

  it('une líneas data y rechaza JSON inválido', () => {
    const receive = jest.fn();
    const parser = createParser(receive);
    parser.push('event: content\ndata: {\ndata: "delta":"hola"}\n\n');
    expect(receive).toHaveBeenCalledWith('content', { delta: 'hola' });
    expect(() => parser.push('data: inválido\n\n')).toThrow();
  });
});
