import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { PUSH_DEVICE_SCHEMA, RegisterPushDeviceDto } from './dto/push-device.dto';
import { PushDevicesService } from './push-devices.service';

const UNAUTHORIZED = 'Access token missing, invalid or expired, its session was revoked, or the account is not active.';

/**
 * P3-BE05 push device registrations of the authenticated user. The owner and
 * session always come from the access token; no endpoint accepts a user or
 * session id. Push is optional: the notification inbox works without it.
 */
@ApiTags('Push devices')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('push-devices')
export class PushDevicesController {
  constructor(private readonly devices: PushDevicesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register or refresh this installation for push',
    description:
      'Idempotent upsert for the session of the access token. Call it with every value delivered by `onRegistered()` and on each app start-up. ' +
      '`result`: CREATED (new), REFRESHED (same value, timestamp updated), ROTATED (this session\'s previous value replaced), ' +
      'TRANSFERRED (the installation was active for another session/account, which lost it).',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['result', 'device'],
      properties: { result: { type: 'string', enum: ['CREATED', 'REFRESHED', 'ROTATED', 'TRANSFERRED'] }, device: PUSH_DEVICE_SCHEMA },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid kind, platform or value (or unknown fields such as userId).' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiConflictResponse({
    description: '`code: REGISTRATION_TRANSFERRED`: this session lost the installation to another account; a stale request from the previous account cannot reclaim it.',
  })
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterPushDeviceDto) {
    return this.devices.register(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my active push devices', description: 'Safe projection: no registration values. `current` marks this browser/app.' })
  @ApiOkResponse({ schema: { type: 'array', items: PUSH_DEVICE_SCHEMA } })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one of my push devices', description: 'Stops push to that device. Idempotent for your own device. Inbox notifications are not affected.' })
  @ApiNoContentResponse({ description: 'Revoked (or already revoked).' })
  @ApiBadRequestResponse({ description: 'id is not a valid positive integer.' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiNotFoundResponse({ description: 'No such device for this user (other users\' devices are indistinguishable from missing ones).' })
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseBigIntIdPipe) id: string): Promise<void> {
    await this.devices.revoke(user, id);
  }
}
