import { ApiProperty } from '@nestjs/swagger';

/**
 * The error body produced by AllExceptionsFilter. Referenced by `@ApiResponse`
 * on error statuses so the docs show the exact failure shape.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 404, description: 'HTTP status code.' })
  statusCode!: number;

  @ApiProperty({
    example: '2026-07-13T01:03:25.033Z',
    format: 'date-time',
    description: 'When the error was produced.',
  })
  timestamp!: string;

  @ApiProperty({
    example: '/api/v1/users/me',
    description: 'Request path that failed.',
  })
  path!: string;

  @ApiProperty({
    description:
      'Human-readable message, or an array of validation messages for 400 responses.',
    oneOf: [
      { type: 'string', example: 'User uid-1 not found' },
      {
        type: 'array',
        items: { type: 'string' },
        example: ['displayName should not be empty'],
      },
    ],
  })
  message!: string | string[];

  @ApiProperty({
    required: false,
    example: 'Not Found',
    description: 'Short error label (present for HttpExceptions).',
  })
  error?: string;
}
