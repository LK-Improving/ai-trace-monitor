import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
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

  @Post(':projectId/keys')
  createProjectKey(@Param('projectId') projectId: string, @Body() body: unknown) {
    return this.projects.createProjectKey(projectId, body);
  }

  @Delete(':projectId/keys/:keyId')
  revokeProjectKey(@Param('projectId') projectId: string, @Param('keyId') keyId: string) {
    return this.projects.revokeProjectKey(projectId, keyId);
  }
}
