import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Small DOM substitute to exercise the actual browser handlers without extra dependencies.
function setup() {
  const elements: Record<string, any> = {};
  for (const id of ['generation-form', 'message', 'generate', 'stop', 'status', 'response']) {
    elements[id] = {
      value: 'Hola', textContent: '', disabled: false, dataset: {}, handlers: {},
      addEventListener(name: string, handler: unknown) { this.handlers[name] = handler; },
      append(text: string) { this.textContent += text; },
      setCustomValidity: jest.fn(), reportValidity: jest.fn(),
    };
  }
  const fetchMock = jest.fn();
  const parser = readFileSync(join(__dirname, '../public/sse-parser.js'), 'utf8')
    .replace('export function', 'function');
  const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8')
    .replace(/^import .*;\r?\n/, '');
  runInNewContext(parser + '\n' + app, {
    AbortController, TextDecoder, fetch: fetchMock,
    document: { querySelector: (selector: string) => elements[selector.slice(1)], createTextNode: (text: string) => text },
  });
  const submit = () => elements['generation-form'].handlers.submit({ preventDefault() {} }) as Promise<void>;
  const stop = () => elements.stop.handlers.click();
  return { elements, fetchMock, submit, stop };
}

function responseWith(wire: string) {
  const reader = {
    read: jest.fn().mockResolvedValueOnce({ value: new TextEncoder().encode(wire), done: false })
      .mockResolvedValue({ done: true }),
    cancel: jest.fn().mockResolvedValue(undefined), releaseLock: jest.fn(),
  };
  return { response: { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => reader } }, reader };
}

describe('Controles del navegador', () => {
  it('completa progresivamente y libera el lector y los botones', async () => {
    const { elements, fetchMock, submit } = setup();
    const { response, reader } = responseWith('event: content\ndata: {"delta":"Hola"}\n\nevent: completed\ndata: {"status":"completed"}\n\n');
    fetchMock.mockResolvedValue(response);
    await submit();
    expect(elements.response.textContent).toBe('Hola');
    expect(elements.status.textContent).toBe('Completado');
    expect(elements.generate.disabled).toBe(false);
    expect(elements.stop.disabled).toBe(true);
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it('conserva texto parcial y aísla la siguiente generación de un rechazo tardío', async () => {
    const { elements, fetchMock, submit, stop } = setup();
    let rejectOld!: (error: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = submit();
    elements.response.textContent = 'Texto parcial';
    stop();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(elements.response.textContent).toBe('Texto parcial');
    expect(elements.status.textContent).toBe('Interrumpido');
    expect(elements.generate.disabled).toBe(false);
    expect(elements.stop.disabled).toBe(true);

    let resolveNew!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const next = submit();
    rejectOld(Object.assign(new Error('cancelado'), { name: 'AbortError' }));
    await old;
    expect(elements.status.textContent).toBe('Esperando');
    expect(elements.generate.disabled).toBe(true);
    expect(elements.stop.disabled).toBe(false);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    resolveNew(responseWith('event: content\ndata: {"delta":"Nuevo"}\n\nevent: completed\ndata: {"status":"completed"}\n\n').response);
    await next;
    expect(elements.response.textContent).toBe('Nuevo');
    expect(elements.status.textContent).toBe('Completado');
  });

  it('muestra un error seguro y permite reintentar', async () => {
    const { elements, fetchMock, submit } = setup();
    fetchMock.mockRejectedValue(new Error('detalle privado'));
    await submit();
    expect(elements.status.textContent).toBe('Error: No fue posible generar la respuesta. Inténtalo nuevamente.');
    expect(elements.generate.disabled).toBe(false);
    expect(elements.stop.disabled).toBe(true);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
