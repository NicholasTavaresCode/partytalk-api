import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  getSchemaPath,
} from '@nestjs/swagger';

interface EnvelopeOptions {
  /** Wrap the model in an array (list endpoints). */
  isArray?: boolean;
  /** Human description of the payload for the docs. */
  description?: string;
  /** Use 201 Created instead of 200 OK. */
  created?: boolean;
}

/**
 * Documents a successful response using the *real* wire shape produced by
 * TransformInterceptor: `{ data: <model>, meta: { timestamp } }`. Every
 * controller pairs its `@ApiOperation` with this so the generated OpenAPI schema
 * matches what clients actually receive, arrays and all.
 */
export const ApiEnvelopeResponse = <TModel extends Type<unknown>>(
  model: TModel,
  options: EnvelopeOptions = {},
) => {
  const dataSchema = options.isArray
    ? { type: 'array' as const, items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  const responseOptions = {
    description: options.description,
    schema: {
      type: 'object' as const,
      required: ['data', 'meta'],
      properties: {
        data: dataSchema,
        meta: {
          type: 'object' as const,
          required: ['timestamp'],
          properties: {
            timestamp: {
              type: 'string' as const,
              format: 'date-time',
              example: '2026-07-13T01:03:25.033Z',
            },
          },
        },
      },
    },
  };

  return applyDecorators(
    ApiExtraModels(model),
    options.created
      ? ApiCreatedResponse(responseOptions)
      : ApiOkResponse(responseOptions),
  );
};
