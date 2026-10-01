import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanEventSchema } from '@trace-ops/contracts';
import { DatabaseService } from '../database/database.service';
import { SpanKafkaQueue } from '../spans/span-kafka-queue.service';
import { TraceRecorder } from './trace-recorder';

type State = 'disabled' | 'ready' | 'invalid_configuration' | 'unregistered_binding' | 'dependency_unavailable';

/** Server-owned binding only: never derive tenancy from HTTP bodies or headers. */
@Injectable()
export class TraceObservabilityService implements OnModuleInit {
  private active?: TraceRecorder;
  private state: State = 'disabled';

  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
    private readonly queue: SpanKafkaQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('SERVER_TRACE_ENABLED') !== 'true') return;
    const binding = SpanEventSchema.safeParse({
      projectId: this.config.get<string>('SERVER_TRACE_PROJECT_ID'),
      service: this.config.get<string>('SERVER_TRACE_SERVICE'),
      environment: this.config.get<string>('SERVER_TRACE_ENVIRONMENT'),
      traceId: 'binding-validation', spanId: 'binding-validation',
      operation: 'http.server', startTime: 0, status: 'ok', attributes: {},
    });
    if (!binding.success) { this.state = 'invalid_configuration'; return; }
    binding.data.projectId = binding.data.projectId.toLowerCase();
    let timer: NodeJS.Timeout | undefined;
    try {
      // One startup check, not a database query on the business request path.
      const registered = await Promise.race([
        this.database.query(
          `SELECT s.id FROM services s JOIN projects p ON p.id = s.project_id
           WHERE s.project_id = $1 AND s.name = $2 AND s.environment = $3 AND p.status = 'active'`,
          [binding.data.projectId, binding.data.service, binding.data.environment],
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Trace binding check unavailable')), 1500);
        }),
      ]);
      if (registered.rows.length === 0) { this.state = 'unregistered_binding'; return; }
      this.active = new TraceRecorder({
        projectId: binding.data.projectId,
        service: binding.data.service,
        environment: binding.data.environment,
      }, event => this.queue.enqueue([event]));
      this.state = 'ready';
    } catch {
      // Monitoring configuration/dependencies must not prevent API availability.
      this.state = 'dependency_unavailable';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  recorder(): TraceRecorder | undefined { return this.active; }
  status(): { state: State } { return { state: this.state }; }
}
