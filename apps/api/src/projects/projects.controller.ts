import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(AdminTokenGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  listProjects() {
    return this.projects.listProjects();
  }

  @Post()
  createProject(@Body() body: unknown) {
    return this.projects.createProject(body);
  }

  @Get(':projectId/services')
  listServices(@Param('projectId') projectId: string) {
    return this.projects.listServices(projectId);
  }

  @Post(':projectId/services')
  createService(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.projects.createService(projectId, body);
  }

  @Get(':projectId/environments')
  listEnvironments(@Param('projectId') projectId: string) {
    return this.projects.listEnvironments(projectId);
  }

  @Get(':projectId/keys')
  listProjectKeys(@Param('projectId') projectId: string) {
    return this.projects.listProjectKeys(projectId);
  }

  @Post(':projectId/keys/:keyId/rotate')
  rotateProjectKey(@Param('projectId') projectId: string, @Param('keyId') keyId: string) {
    return this.projects.rotateProjectKey(projectId, keyId);
  }

  @Post(':projectId/keys')
  createProjectKey(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.projects.createProjectKey(projectId, body);
  }

  @Delete(':projectId/keys/:keyId')
  revokeProjectKey(@Param('projectId') projectId: string, @Param('keyId') keyId: string) {
    return this.projects.revokeProjectKey(projectId, keyId);
  }

  @Get(':projectId/privacy')
  getPrivacyPolicy(@Param('projectId') projectId: string) {
    return this.projects.getPrivacyPolicy(projectId);
  }

  @Patch(':projectId/privacy')
  updatePrivacyPolicy(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.projects.updatePrivacyPolicy(projectId, body);
  }

  @Get(':projectId/audit-logs')
  listAuditLogs(@Param('projectId') projectId: string, @Query() query: Record<string, unknown>) {
    return this.projects.listAuditLogs(projectId, query);
  }
}
