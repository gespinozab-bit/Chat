import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GenerateDto } from './dto/generate.dto';
import { GenerationService } from './generation.service';

@Controller('generate')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post()
  generate(@Body() dto: GenerateDto, @Res() response: Response): Promise<void> {
    return this.generationService.generate(dto, response);
  }
}
