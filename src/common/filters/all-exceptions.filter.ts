import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

interface ErrorResponseBody {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string | string[];
  error?: string;
}

/**
 * Centralized exception handling (error-use-exception-filters). Produces a
 * consistent JSON error shape for HTTP requests and never leaks internal error
 * details or stack traces to the client for unexpected errors. Uses
 * `HttpAdapterHost` so it is transport-agnostic.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, error } = this.extractMessage(exception, httpStatus);

    if (httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Log full detail server-side; return a generic message to the client.
      this.logger.error(
        `Unhandled exception on ${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      message,
      error,
    };

    httpAdapter.reply(ctx.getResponse(), body, httpStatus);
  }

  private extractMessage(
    exception: unknown,
    status: number,
  ): { message: string | string[]; error?: string } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { message: response };
      }
      const asObject = response as Record<string, unknown>;
      return {
        message: (asObject.message as string | string[]) ?? exception.message,
        error: asObject.error as string | undefined,
      };
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return { message: 'Internal server error' };
    }

    return { message: 'Unexpected error' };
  }
}
