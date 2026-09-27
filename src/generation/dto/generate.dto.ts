import { Transform } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class GenerateDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;
}
