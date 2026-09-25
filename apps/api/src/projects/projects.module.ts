import { Module } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [AdminTokenGuard, ProjectsService],
})
export class ProjectsModule {}
