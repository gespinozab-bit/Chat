import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { SseResponse } from '../src/generation/sse-response';

describe('Cierre y escritura SSE', () => {
  function setup(onDisconnect = jest.fn()) {
    const response = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: true,
      write: jest.fn().mockReturnValue(true), end: jest.fn(),
    });
    return { response, sse: new SseResponse(response as unknown as Response, onDisconnect), onDisconnect };
  }

  it('deja de escribir al desconectarse el navegador', async () => {
    const { response, sse } = setup();
    response.emit('close');
    expect(await sse.send('content', { delta: 'texto' })).toBe(false);
    sse.end();
    expect(response.write).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('no cancela por un cierre normal después de end', () => {
    const { response, sse, onDisconnect } = setup();
    response.writableEnded = true;
    response.emit('close');
    expect(onDisconnect).not.toHaveBeenCalled();
    sse.end();
  });

  it('notifica solo una vez el cierre prematuro y no envía errores SSE', async () => {
    const { response, sse, onDisconnect } = setup();
    response.emit('error', new Error('socket cerrado'));
    response.emit('close');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(await sse.send('error', { message: 'error seguro' })).toBe(false);
    expect(response.write).not.toHaveBeenCalled();
    sse.end();
  });

  it('una desconexión libera la espera de escritura', async () => {
    const { response, sse } = setup();
    response.write.mockReturnValue(false);
    const sending = sse.send('content', { delta: 'texto' });
    response.emit('close');
    expect(await sending).toBe(false);
    expect(response.listenerCount('drain')).toBe(0);
    sse.end();
  });

  it('espera drain y cierra la respuesta activa', async () => {
    const { response, sse } = setup();
    response.write.mockReturnValue(false);
    const sending = sse.send('content', { delta: 'texto' });
    response.emit('drain');
    expect(await sending).toBe(true);
    sse.end();
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
