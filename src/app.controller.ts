import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // P3-BE12: documented as it is (kept for compatibility; QA tooling polls it).
  @ApiTags('Health')
  @ApiOperation({ summary: 'API root: plain-text greeting (use /api/health/live and /api/health/ready for probes)' })
  @ApiProduces('text/html')
  @ApiOkResponse({ description: '`Hello World!`', schema: { type: 'string', example: 'Hello World!' } })
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
