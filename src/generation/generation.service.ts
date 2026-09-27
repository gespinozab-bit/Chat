import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import OpenAI from 'openai';
import { GenerateDto } from './dto/generate.dto';
import { SseResponse } from './sse-response';

const SAFE_ERROR = 'No fue posible completar la generación.';

@Injectable()
export class GenerationService {
  private client?: OpenAI;
  private readonly logger = new Logger(GenerationService.name);

  constructor(private readonly config: ConfigService) {}

  async generate(dto: GenerateDto, response: Response): Promise<void> {
    // Validate before opening SSE, without preventing application startup.
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    const model = this.config.get<string>('OPENAI_MODEL')?.trim();
    if (!apiKey || !model) throw new ServiceUnavailableException(SAFE_ERROR);
    try {
      this.client ??= new OpenAI({ apiKey, maxRetries: 0, logLevel: 'off' });
    } catch {
      throw new ServiceUnavailableException(SAFE_ERROR);
    }

    const controller = new AbortController();
    let completed = false;
    let disconnected = false;
    const onDisconnect = (): void => {
      if (response.writableEnded || completed || disconnected) return;
      disconnected = true;
      controller.abort();
      this.logger.log('Conexión cerrada: cancelación enviada al SDK de OpenAI.');
    };
    const sse = new SseResponse(response, onDisconnect);
    let generating = false;
    try {
      sse.open();
      if (!await sse.send('status', { status: 'waiting' })) return;
      const stream = await this.client.responses.create({
        model, input: dto.message, stream: true, store: false,
      }, { signal: controller.signal });
      for await (const event of stream) {
        if (sse.closed) return;
        if (event.type === 'response.output_text.delta') {
          if (!generating) {
            if (!await sse.send('status', { status: 'generating' })) return;
            generating = true;
          }
          if (!await sse.send('content', { delta: event.delta })) return;
        } else if (event.type === 'response.completed') {
          completed = true;
          await sse.send('completed', { status: 'completed' });
          return;
        } else if (event.type === 'error' || event.type === 'response.failed' ||
                   event.type === 'response.incomplete') {
          throw new Error(SAFE_ERROR);
        }
      }
      // EOF alone is not successful completion.
      if (!sse.closed) throw new Error(SAFE_ERROR);
    } catch {
      if (disconnected || sse.closed) return;
      this.logger.warn('La generación no pudo completarse.');
      if (!response.headersSent) throw new ServiceUnavailableException(SAFE_ERROR);
      await sse.send('error', { message: SAFE_ERROR });
    } finally {
      // Also dispose unfinished provider work after write or protocol failures.
      if (!completed) controller.abort();
      sse.end();
      if (disconnected) this.logger.log('Consumo del stream detenido; recursos de la solicitud liberados.');
    }
  }
}
