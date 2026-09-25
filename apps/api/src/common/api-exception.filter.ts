import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
}

function statusLabel(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST: return 'Bad Request';
    case HttpStatus.UNAUTHORIZED: return 'Unauthorized';
    case HttpStatus.NOT_FOUND: return 'Not Found';
    case HttpStatus.CONFLICT: return 'Conflict';
    case HttpStatus.SERVICE_UNAVAILABLE: return 'Service Unavailable';
    case HttpStatus.PAYLOAD_TOO_LARGE: return 'Payload Too Large';
    default: return status >= 500 ? 'Internal Server Error' : 'Request Error';
  }
}

function bodyParserError(exception: unknown): 'too_large' | 'invalid_json' | undefined {
  if (exception === null || typeof exception !== 'object' || !('type' in exception)) return undefined;
  const type = (exception as { type?: unknown }).type;
  if (type === 'entity.too.large') return 'too_large';
  if (type === 'entity.parse.failed') return 'invalid_json';
  return undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const parserError = bodyParserError(exception);
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : parserError === 'too_large'
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : parserError === 'invalid_json'
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const details = exception instanceof HttpException ? exception.getResponse() : undefined;
    const rawMessage = typeof details === 'string'
      ? details
      : details !== null && typeof details === 'object' && 'message' in details
        ? (details as { message: unknown }).message
        : undefined;
    const message = parserError === 'too_large'
      ? 'Request body is too large'
      : parserError === 'invalid_json'
        ? 'Request body is invalid JSON'
        : status >= 500
      ? (status === HttpStatus.SERVICE_UNAVAILABLE ? 'Service is unavailable' : 'Request could not be completed')
      : typeof rawMessage === 'string' || Array.isArray(rawMessage)
        ? rawMessage
        : statusLabel(status);

    response.status(status).json({ statusCode: status, error: statusLabel(status), message });
  }
}
