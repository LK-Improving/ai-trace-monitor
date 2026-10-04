import { apiFetch } from './api';
import { parseProjectsPayload, type ProjectOption } from './overview-api';

export interface CreateProjectInput {
  name: string;
  slug: string;
  retentionDays: number;
}

export async function createProject(input: CreateProjectInput, signal?: AbortSignal): Promise<ProjectOption> {
  const name = input.name.trim();
  const slug = input.slug.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)
    || slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    || !Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
    throw new TypeError('请检查项目名称、英文标识和保留天数。');
  }
  let response: Response;
  try {
    response = await apiFetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, slug, retentionDays: input.retentionDays }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw new Error('无法连接项目 API，请确认本地服务已启动。');
  }
  if (response.status === 409) throw new Error('项目标识已存在，请换一个。');
  if (response.status === 401 || response.status === 403) throw new Error('当前管理凭证无权创建项目。');
  if (!response.ok) throw new Error(`创建项目失败（HTTP ${response.status}）。`);
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error('项目创建成功，但接口响应无法读取；请刷新项目列表确认。');
  }
  return parseProjectsPayload([payload])[0]!;
}
