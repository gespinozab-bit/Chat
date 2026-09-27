import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
const create = jest.fn();
let configured = true;

async function* successfulStream() {
  yield { type: 'response.output_text.delta', delta: 'Hola\n' };
  yield { type: 'response.output_text.delta', delta: 'mundo 🌎' };
  yield { type: 'response.completed' };
}

describe('Sprint 3 - API (proveedor sustituido solo en pruebas)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({ responses: { create } }));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService).useValue({
        get: (name: string) => configured ? (name === 'OPENAI_MODEL' ? 'test-model' : 'test-only') : '',
      }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    configured = true;
    create.mockReset().mockImplementation(() => successfulStream());
  });

  it('recibe y normaliza el mensaje', async () => {
    const result = await request(app.getHttpServer()).post('/api/generate')
      .send({ message: '  Hola   mundo\n ' }).expect(200)
      .expect('Content-Type', 'text/event-stream; charset=utf-8')
      .expect('Cache-Control', 'no-cache').expect('Connection', 'keep-alive')
      .expect('X-Accel-Buffering', 'no');
    expect(create).toHaveBeenCalledWith(
      { model: 'test-model', input: 'Hola mundo', stream: true, store: false },
      { signal: expect.any(AbortSignal) },
    );
    expect(create.mock.calls[0][1].signal.aborted).toBe(false);
    expect(result.text).toBe(
      'event: status\ndata: {"status":"waiting"}\n\n' +
      'event: status\ndata: {"status":"generating"}\n\n' +
      'event: content\ndata: {"delta":"Hola\\n"}\n\n' +
      'event: content\ndata: {"delta":"mundo 🌎"}\n\n' +
      'event: completed\ndata: {"status":"completed"}\n\n',
    );
  });

  it.each([
    {}, { message: null }, { message: 123 }, { message: [] },
    { message: {} }, { message: '' }, { message: ' \n\t ' },
    { message: 'a'.repeat(2001) }, { message: 'Hola', extra: true },
  ])('rechaza un cuerpo inválido (caso %#)', async (body) => {
    const result = await request(app.getHttpServer()).post('/api/generate')
      .send(body).expect(400);
    expect(result.body).not.toHaveProperty('stack');
    expect(create).not.toHaveBeenCalled();
  });

  it('acepta el límite de 2000 caracteres', async () => {
    await request(app.getHttpServer()).post('/api/generate')
      .send({ message: 'a'.repeat(2000) }).expect(200);
  });

  it('sirve la página y sus recursos', async () => {
    await request(app.getHttpServer()).get('/').expect(200).expect(/<html lang="es">/);
    await request(app.getHttpServer()).get('/styles.css').expect(200);
    await request(app.getHttpServer()).get('/app.js').expect(200);
    await request(app.getHttpServer()).get('/sse-parser.js').expect(200);
  });

  it('retira el endpoint temporal y no publica archivos privados', async () => {
    await request(app.getHttpServer()).post('/api/generate/test').send({ message: 'Hola' }).expect(404);
    await request(app.getHttpServer()).get('/.env').expect(404);
    await request(app.getHttpServer()).get('/src/main.ts').expect(404);
  });

  it('devuelve un error HTTP seguro si falta configuración', async () => {
    configured = false;
    const result = await request(app.getHttpServer()).post('/api/generate')
      .send({ message: 'Hola' }).expect(503);
    expect(result.body.message).toBe('No fue posible completar la generación.');
    expect(result.body).not.toHaveProperty('stack');
    expect(create).not.toHaveBeenCalled();
  });

  it('oculta errores del SDK después de abrir SSE', async () => {
    create.mockRejectedValue(new Error('detalles privados del proveedor'));
    const result = await request(app.getHttpServer()).post('/api/generate')
      .send({ message: 'Hola' }).expect(200);
    expect(result.text).toBe('event: status\ndata: {"status":"waiting"}\n\n' +
      'event: error\ndata: {"message":"No fue posible completar la generación."}\n\n');
  });

  it.each(['response.failed', 'response.incomplete', 'error', 'EOF'])
    ('no confunde %s con finalización correcta', async (type) => {
      create.mockImplementation(async function* () {
        yield { type: 'response.output_text.delta', delta: 'Parcial' };
        if (type !== 'EOF') yield { type, message: 'detalle privado' };
      });
      const result = await request(app.getHttpServer()).post('/api/generate')
        .send({ message: 'Hola' }).expect(200);
      expect(result.text).toContain('event: content');
      expect(result.text).toContain('event: error');
      expect(result.text).not.toContain('event: completed');
      expect(result.text).not.toContain('detalle privado');
    });

  it('entrega un delta por HTTP antes de que el proveedor termine', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    create.mockImplementation(async function* () {
      yield { type: 'response.output_text.delta', delta: 'Primero' };
      await gate;
      yield { type: 'response.completed' };
      yield { type: 'response.output_text.delta', delta: 'No debe enviarse' };
    });
    const result = await fetch(`${await app.getUrl()}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hola' }),
    });
    const reader = result.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!text.includes('Primero')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).not.toContain('event: completed');
    } finally { finish(); }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('event: completed');
    expect(text).not.toContain('No debe enviarse');
    reader.releaseLock();
  });

  it.each([false, true])('propaga el cierre HTTP al SDK (stream abierto: %s)', async (opened) => {
    let signal!: AbortSignal;
    let notifyStopped!: () => void;
    let notifyStarted!: () => void;
    const stopped = new Promise<void>(resolve => { notifyStopped = resolve; });
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    create.mockImplementation((_body, options: { signal: AbortSignal }) => {
      signal = options.signal;
      notifyStarted();
      if (!opened) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
            notifyStopped();
          }, { once: true });
        });
      }
      return (async function* () {
        try {
          const aborted = new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'response.output_text.delta', delta: 'Texto parcial' };
          await aborted;
        } finally { notifyStopped(); }
      })();
    });
    const browser = new AbortController();
    const result = await fetch(`${await app.getUrl()}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hola' }), signal: browser.signal,
    });
    await started;
    const reader = result.body!.getReader();
    try {
      if (opened) {
        let received = '';
        while (!received.includes('Texto parcial')) {
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          received += new TextDecoder().decode(chunk.value);
        }
      }
      browser.abort();
      await stopped;
      expect(signal.aborted).toBe(true);
    } finally {
      browser.abort();
      reader.releaseLock();
    }
    // A subsequent request gets an independent, non-aborted signal.
    create.mockImplementation(() => successfulStream());
    await request(app.getHttpServer()).post('/api/generate')
      .send({ message: 'Otra solicitud' }).expect(200);
    const nextSignal = create.mock.calls[1][1].signal;
    expect(nextSignal).not.toBe(signal);
    expect(nextSignal.aborted).toBe(false);
  });
});
